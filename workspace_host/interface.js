const ERR = require('async-stacktrace');
const util = require('util');
const express = require('express');
const app = express();
const http = require('http');
const request = require('request');
const path = require('path');
const AWS = require('aws-sdk');
const Docker = require('dockerode');
const fs = require('fs');
const async = require('async');
const socketServer = require('../lib/socket-server'); // must load socket server before workspace
const workspaceHelper = require('../lib/workspace');
const logger = require('../lib/logger');
const chokidar = require('chokidar');
const fsPromises = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const argv = require('yargs-parser') (process.argv.slice(2));
const debug = require('debug')('prairielearn:' + path.basename(__filename, '.js'));
const archiver = require('archiver');

const sqldb = require('@prairielearn/prairielib/sql-db');
const sqlLoader = require('@prairielearn/prairielib/sql-loader');
const sql = sqlLoader.loadSqlEquiv(__filename);

const aws = require('../lib/aws.js');
const config = require('../lib/config');
let configFilename = 'config.json';
if ('config' in argv) {
    configFilename = argv['config'];
}
config.loadConfig(configFilename);
const zipPrefix = config.workspaceGradedFilesSendDirectory;

logger.info('Workspace S3 bucket: ' + config.workspaceS3Bucket);

const bodyParser = require('body-parser');
const docker = new Docker();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// TODO: refactor into RESTful endpoints (https://github.com/PrairieLearn/PrairieLearn/pull/2841#discussion_r467245108)
app.post('/', function(req, res) {
    var workspace_id = req.body.workspace_id;
    var action = req.body.action;
    if (workspace_id == undefined) {
        res.status(500).send('Missing workspace_id');
    } else if (action == undefined) {
        res.status(500).send('Missing action');
    } else if (action == 'init') {
        initSequence(workspace_id, res);
    } else if (action == 'reset') {
        resetSequence(workspace_id, res);
    } else if (action == 'getGradedFiles') {
        gradeSequence(workspace_id, res);
    } else if (action == 'status') {
        res.status(200).send('Running');
    } else {
        res.status(500).send(`Action '${action}' undefined`);
    }
});

let server;
let workspace_server_settings = {
    instance_id: config.workspaceDevHostInstanceId,
    /* The workspace server's hostname */
    hostname: config.workspaceDevHostHostname,
    /* How the main server connects to the container.  In docker, this is the host operating system. */
    server_to_container_hostname: config.workspaceDevContainerHostname,
    port: config.workspaceHostPort,
};

async.series([
    (callback) => {
        const pgConfig = {
            user: config.postgresqlUser,
            database: config.postgresqlDatabase,
            host: config.postgresqlHost,
            password: config.postgresqlPassword,
            max: 100,
            idleTimeoutMillis: 30000,
        };
        logger.verbose(`Connecting to database ${pgConfig.user}@${pgConfig.host}:${pgConfig.database}`);
        const idleErrorHandler = function(err) {
            logger.error('idle client error', err);
            // https://github.com/PrairieLearn/PrairieLearn/issues/2396
            process.exit(1);
        };
        sqldb.init(pgConfig, idleErrorHandler, function(err) {
            if (ERR(err, callback)) return;
            logger.verbose('Successfully connected to database');
            callback(null);
        });
    },
    (callback) => {
        aws.init((err) => {
            if (ERR(err, callback)) return;
            callback(null);
        });
    },
    (callback) => {
        socketServer.init(server, function(err) {
            if (ERR(err, callback)) return;
            callback(null);
        });
    },
    (callback) => {
        util.callbackify(workspaceHelper.init)(err => {
            if (ERR(err, callback)) return;
            callback(null);
        });
    },
    (callback) => {
        if (config.runningInEc2) {
            const MetadataService = new AWS.MetadataService();
            async.series([
                (callback) => {
                    MetadataService.request('/latest/dynamic/instance-identity/document', (err, document) => {
                        if (ERR(err, callback)) return;
                        try {
                            const data = JSON.parse(document);
                            logger.info('instance-identity', data);
                            AWS.config.update({'region': data.region});
                            workspace_server_settings.instance_id = data.instanceId;
                            callback(null);
                        } catch (err) {
                            return callback(err);
                        }
                    });
                },
                (callback) => {
                    MetadataService.request('/latest/meta-data/local-hostname', (err, hostname) => {
                        if (ERR(err, callback)) return;
                        workspace_server_settings.hostname = hostname;
                        workspace_server_settings.server_to_container_hostname = hostname;
                        callback(null);
                    });
                },
            ], (err) => {
                if (ERR(err, callback)) return;
                callback(null);
            });
        } else {
            /* Not running in ec2 */
            callback(null);
        }
    },
    (callback) => {
        fs.mkdir(zipPrefix, { recursive: true, mode: 0o700 }, (err) => {
            if (ERR(err, callback)) return;
            callback(null);
        });
    },
    async () => {
        /* If we have any running workspaces we're probably recovering from a crash
           and we should sync files to S3 */
        const result = await sqldb.queryAsync(sql.get_running_workspaces, { instance_id: workspace_server_settings.instance_id });
        await async.each(result.rows, async (ws) => {
            if (ws.state == 'launching') {
                /* We don't know what state the container is in, kill it and let the user
                   retry initializing it */
                const container = await _getDockerContainerByLaunchUuid(ws.launch_uuid);
                try {
                    await container.kill();
                } catch (err) {
                    logger.info(`Couldn't kill container ${ws.launch_uuid}: ${err}`);
                }
                await container.remove();
                await workspaceHelper.updateState(ws.id, 'stopped');
            } else if (ws.state == 'running') {
                await pushContainerContentsToS3(ws);
            }
        });
    },
    (callback) => {
        server = http.createServer(app);
        server.listen(workspace_server_settings.port);
        logger.info(`Listening on port ${workspace_server_settings.port}`);
        callback(null);
    },
    (callback) => {
        // Add ourselves to the workspace hosts directory. After we
        // do this we will start receiving requests so everything else
        // must be initialized before this.
        const params = {
            hostname: workspace_server_settings.hostname + ':' + workspace_server_settings.port,
            instance_id: workspace_server_settings.instance_id,
        };
        sqldb.query(sql.insert_workspace_hosts, params, function(err, _result) {
            if (ERR(err, callback)) return;
            callback(null);
        });
    },
], function(err, data) {
    if (err) {
        logger.error('Error initializing workspace host:', err, data);
    } else {
        logger.info('Successfully initialized workspace host');
    }
});

// For detecting file changes
let update_queue = {};  // key: path of file on local, value: action ('update' or 'remove').
const workspacePrefix = config.workspaceJobsDirectory;
const watcher = chokidar.watch(workspacePrefix, {ignoreInitial: true,
    awaitWriteFinish: true,
    depth: 10,
});
watcher.on('add', filename => {
    // Handle new files
    var key = [filename, false];
    if (key in update_queue && update_queue[key].action == 'skip') {
        delete update_queue[key];
    } else {
        update_queue[key] = {action: 'update'};
    }
});
watcher.on('addDir', filename => {
    // Handle new directory
    var key = [filename, true];
    if (key in update_queue && update_queue[key].action == 'skip') {
        delete update_queue[key];
    } else {
        update_queue[key] = {action: 'update'};
    }
});
watcher.on('change', filename => {
    // Handle file changes
    var key = [filename, false];
    if (key in update_queue && update_queue[key].action == 'skip') {
        delete update_queue[key];
    } else {
        update_queue[key] = {action: 'update'};
    }
});
watcher.on('unlink', filename => {
    // Handle removed files
    var key = [filename, false];
    update_queue[key] = {action: 'delete'};
});
watcher.on('unlinkDir', filename => {
    // Handle removed directory
    var key = [filename, true];
    update_queue[key] = {action: 'delete'};
});
setInterval(_autoUpdateJobManager, config.workspaceHostFileWatchIntervalSec * 1000);

/* Periodic hard-push of files to S3 */

/**
 * Push all of the contents of a container's home directory to S3.
 * @param {object} workspace Workspace object, this should contain at least the launch_uuid and id.
 */
async function pushContainerContentsToS3(workspace) {
    const workspaceDir = (process.env.HOST_JOBS_DIR ? path.join(process.env.HOST_JOBS_DIR, 'workspaces') : config.workspaceJobsDirectory);
    const workspacePath = path.join(workspaceDir, `workspace-${workspace.launch_uuid}`);
    const settings = await _getWorkspaceSettingsAsync(workspace.id);
    await workspaceHelper.uploadDirectoryToS3Async(workspacePath, `${config.workspaceS3Bucket}/workspace-${workspace.id}`, settings.workspace_sync_ignore);
}

async function pushAllRunningContainersToS3() {
    const result = await sqldb.queryAsync(sql.get_running_workspaces, { instance_id: workspace_server_settings.instance_id });
    await async.each(result.rows, async (ws) => {
        if (ws.state == 'running') {
            await pushContainerContentsToS3(ws);
        }
    });
}
setInterval(pushAllRunningContainersToS3, config.workspaceHostForceUploadIntervalSec * 1000);

/**
 * Looks up a docker container by the UUID used to launch it.
 * Throws an exception if the container was not found or if there
 * are multiple containers with the same UUID (this shouldn't happen?)
 * @param {string} launch_uuid UUID to search by
 * @return Dockerode container object
 */
async function _getDockerContainerByLaunchUuid(launch_uuid) {
    const containers = await docker.listContainers({
        filters: `name=workspace-${launch_uuid}`,
    });
    if (containers.length !== 1) {
        throw new Error(`Could not find unique container by launch UUID: ${launch_uuid}`);
    }
    return docker.getContainer(containers[0].Id);
}

/**
 * Looks up a workspace object by the workspace id.
 * This object contains all columns in the 'workspaces' table as well as:
 * - local_name (container name)
 * - s3_name (subdirectory name on s3)
 * @param {integer} workspace_id Workspace ID to search by.
 * @return {object} Workspace object, as described above.
 */
async function _getWorkspaceAsync(workspace_id) {
    const result = await sqldb.queryOneRowAsync(sql.get_workspace, {workspace_id});
    const workspace = result.rows[0];
    workspace.local_name = `workspace-${workspace.launch_uuid}`;
    workspace.s3_name = `workspace-${workspace.id}`;
    return workspace;
}

async function _getAvailablePort(workspace) {
    const sql_params = [
        workspace_server_settings.instance_id,
        workspace.id,
    ];
    const result = await sqldb.callAsync('workspace_host_allocate_port', sql_params);
    const port = result.rows[0].port;
    if (!port) {
        throw new Error("Couldn't allocate a new port!");
    }
    return port;
}

function _checkServer(workspace, callback) {
    const checkMilliseconds = 500;
    const maxMilliseconds = 30000;

    const startTime = (new Date()).getTime();
    function checkWorkspace() {
        request(`http://${workspace_server_settings.server_to_container_hostname}:${workspace.launch_port}/`, function(err, res, _body) {
            if (err) { /* do nothing, because errors are expected while the container is launching */ }
            if (res && res.statusCode) {
                /* We might get all sorts of strange status codes from the server, this is okay since it still means the server is running and we're getting responses. */
                callback(null, workspace);
            } else {
                const endTime = (new Date()).getTime();
                if (endTime - startTime > maxMilliseconds) {
                    callback(new Error(`Max startup time exceeded for workspace_id=${workspace.id}`));
                } else {
                    setTimeout(checkWorkspace, checkMilliseconds);
                }
            }
        });
    }
    setTimeout(checkWorkspace, checkMilliseconds);
}

async function _getWorkspaceSettingsAsync(workspace_id) {
    const result = await sqldb.queryOneRowAsync(sql.select_workspace_settings, {workspace_id});
    return {
        workspace_image: result.rows[0].workspace_image,
        workspace_port: result.rows[0].workspace_port,
        workspace_home: result.rows[0].workspace_home,
        workspace_graded_files: result.rows[0].workspace_graded_files,
        workspace_args: result.rows[0].workspace_args || '',
        workspace_sync_ignore: result.rows[0].workspace_sync_ignore || [],
    };
}
const _getWorkspaceSettings = util.callbackify(_getWorkspaceSettingsAsync);

function _getSettingsWrapper(workspace, callback) {
    async.parallel({
        port: async () => { return await _getAvailablePort(workspace); },
        settings: (callback) => {_getWorkspaceSettings(workspace.id, callback);},
    }, (err, results) => {
        if (ERR(err, (err) => logger.error('Error acquiring workspace container settings', err))) return;
        workspace.launch_port = results.port;
        workspace.settings = results.settings;
        callback(null, workspace);
    });
}

async function _uploadToS3Async(filePath, isDirectory, S3FilePath, localPath) {
    const s3 = new AWS.S3();

    let body;
    if (isDirectory) {
        body = '';
        S3FilePath += '/';
    } else {
        try {
            body = await fsPromises.readFile(filePath);
        } catch(err) {
            return [filePath, S3FilePath, err];
        }
    }
    const uploadParams = {
        Bucket: config.workspaceS3Bucket,
        Key: S3FilePath,
        Body: body,
    };

    await s3.upload(uploadParams).promise();
    logger.info(`Uploaded s3://${config.workspaceS3Bucket}/${S3FilePath} (${localPath})`);
}
const _uploadToS3 = util.callbackify(_uploadToS3Async);

async function _deleteFromS3Async(filePath, isDirectory, S3FilePath, localPath) {
    const s3 = new AWS.S3();

    if (isDirectory) {
        S3FilePath += '/';
    }
    const deleteParams = {
        Bucket: config.workspaceS3Bucket,
        Key: S3FilePath,
    };
    await s3.deleteObject(deleteParams).promise();
    logger.info(`Deleted s3://${config.workspaceS3Bucket}/${S3FilePath} (${localPath})`);
}
const _deleteFromS3 = util.callbackify(_deleteFromS3Async);

function _workspaceFileChangeOwner(filepath, callback) {
    if (config.workspaceJobsDirectoryOwnerUid == 0 ||
        config.workspaceJobsDirectoryOwnerGid == 0) {
        /* No-op if there's nothing to do */
        return callback(null);
    }

    fs.chown(filepath, config.workspaceJobsDirectoryOwnerUid, config.workspaceJobsDirectoryOwnerGid, (err) => {
        if (ERR(err, callback)) return;
        callback(null);
    });
}
const _workspaceFileChangeOwnerAsync = util.promisify(_workspaceFileChangeOwner);

async function _downloadFromS3Async(filePath, S3FilePath) {
    if (filePath.slice(-1) == '/') {
        // this is a directory
        filePath = filePath.slice(0, -1);
        try {
            await fsPromises.lstat(filePath);
        } catch(err) {
            await fsPromises.mkdir(filePath, { recursive: true });
            await _workspaceFileChangeOwnerAsync(filePath);
        }
        update_queue[[filePath, true]] = {action: 'skip'};
        return;
    } else {
        // this is a file
        try {
            await fsPromises.lstat(path.dirname(filePath));
        } catch(err) {
            await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        }
    }

    const s3 = new AWS.S3();
    const downloadParams = {
        Bucket: config.workspaceS3Bucket,
        Key: S3FilePath,
    };
    const fileStream = fs.createWriteStream(filePath);
    const s3Stream = s3.getObject(downloadParams).createReadStream();

    return new Promise((resolve, reject) => {
        s3Stream.on('error', function(err) {
            // This is for errors like no such file on S3, etc
            reject(err);
        });
        s3Stream.pipe(fileStream).on('error', function(err) {
            // This is for errors like the connection is lost, etc
            reject(err);
        }).on('close', function() {
            update_queue[[filePath, false]] = {action: 'skip'};
            _workspaceFileChangeOwner(filePath, (err) => {
                if (err) return reject(err);
                resolve();
            });
        });
    });
}
const _downloadFromS3 = util.callbackify(_downloadFromS3Async);

// Extracts `workspace_id` and `/path/to/file` from `/prefix/workspace-${uuid}/path/to/file`
async function _getWorkspaceByPath(path) {
    let localPath = path.replace(`${workspacePrefix}/`, '').split('/');
    const localName = localPath.shift();
    const launch_uuid = localName.replace('workspace-', '');
    localPath = localPath.join('/');

    try {
        const result = await sqldb.queryOneRowAsync(sql.get_workspace_id_by_uuid, { launch_uuid });
        return {
            workspace_id: result.rows[0].workspace_id,
            local_path: localPath,
        };
    } catch (_err) {
        return {
            workspace_id: null,
            local_path: null,
        };
    }
}

async function _autoUpdateJobManager() {
    var jobs = [];
    for (const key in update_queue) {
        const [path, isDirectory_str] = key.split(',');
        const isDirectory = isDirectory_str == 'true';
        const {workspace_id, local_path} = await _getWorkspaceByPath(path);
        if (workspace_id == null) continue;

        debug(`watch: workspace_id=${workspace_id}, localPath=${local_path}`);
        const workspace = await _getWorkspaceAsync(workspace_id);
        const workspaceSettings = await _getWorkspaceSettingsAsync(workspace_id);
        const s3_name = workspace.s3_name;
        const sync_ignore = workspaceSettings.workspace_sync_ignore;
        debug(`watch: workspace_id=${workspace_id}, isDirectory_str=${isDirectory_str}`);
        debug(`watch: localPath=${local_path}`);
        debug(`watch: syncIgnore=${sync_ignore}`);

        if (local_path === '') {
            // skip root localPath as it produces new S3 dir with empty name
            continue;
        } else if (sync_ignore.filter(ignored => local_path.startsWith(ignored)).length > 0) {
            continue;
        } else {
            var s3_path = `${s3_name}/${local_path}`;
        }

        if (update_queue[key].action == 'update') {
            jobs.push((callback) => {
                _uploadToS3(path, isDirectory, s3_path, local_path, callback);
            });
        } else if (update_queue[key].action == 'delete') {
            jobs.push((callback) => {
                _deleteFromS3(path, isDirectory, s3_path, local_path, callback);
            });
        }
    }
    update_queue = {};
    await async.parallel(jobs, function(err) {
        if (err) logger.err(err);
    });
}

function _recursiveDownloadJobManager(curDirPath, S3curDirPath, callback) {
    const s3 = new AWS.S3();

    var listingParams = {
        Bucket: config.workspaceS3Bucket,
        Prefix: S3curDirPath,
    };

    s3.listObjectsV2(listingParams, (err, data) => {
        if (ERR(err, callback)) return;
        var contents = data['Contents'];
        var ret = [];
        contents.forEach(dict => {
          if ('Key' in dict) {
              var filePath = path.join(curDirPath, dict['Key'].slice(S3curDirPath.length));
              var S3filePath = dict['Key'];
              ret.push([filePath, S3filePath]);
          }
      });
      callback(null, ret);
    });
}

function _syncPullContainer(workspace, callback) {
    _recursiveDownloadJobManager(`${workspacePrefix}/${workspace.local_name}`, workspace.s3_name, (err, jobs_params) => {
        if (ERR(err, callback)) return;
        var jobs = [];
        jobs_params.forEach(([filePath, S3filePath]) => {
            jobs.push( ((callback) => {
                _downloadFromS3(filePath, S3filePath, (err) => {
                    if (ERR(err, callback)) return;
                    callback(null);
                });
            }));
        });

        async.parallel(jobs, function(err) {
            if (ERR(err, callback)) return;
            callback(null, workspace.id);
        });
    });
}

function _queryUpdateWorkspaceHostname(workspace_id, port, callback) {
    const hostname = `${workspace_server_settings.server_to_container_hostname}:${port}`;
    sqldb.query(sql.update_workspace_hostname, {workspace_id, hostname}, function(err, _result) {
        if (ERR(err, callback)) return;
        callback(null);
    });
}

function _pullImage(workspace, callback) {
    const workspace_image = workspace.settings.workspace_image;
    if (config.workspacePullImagesFromDockerHub) {
        logger.info(`Pulling docker image: ${workspace_image}`);
        docker.pull(workspace_image, (err, stream) => {
            if (err) {
                logger.error(`Error pulling "${workspace_image}" image; attempting to fall back to cached version.`, err);
                return callback(null);
            }

            docker.modem.followProgress(stream, (err) => {
                if (ERR(err, callback)) return;
                callback(null, workspace);
            }, (output) => {
                logger.info('Docker pull output: ', output);
            });
        });
    } else {
        logger.info('Not pulling docker image');
        callback(null, workspace);
    }
}

function _createContainer(workspace, callback) {
    const localName = workspace.local_name;
    const workspaceDir = (process.env.HOST_JOBS_DIR ? path.join(process.env.HOST_JOBS_DIR, 'workspaces') : config.workspaceJobsDirectory);
    const workspacePath = path.join(workspaceDir, localName); /* Where docker will see the jobs (host path inside docker container) */
    const workspaceJobPath = path.join(workspacePrefix, localName); /* Where we are putting the job files relative to the server (/jobs inside docker container) */
    const containerPath = workspace.settings.workspace_home;
    let args = workspace.settings.workspace_args.trim();
    if (args.length == 0) {
        args = null;
    } else {
        args = args.split(' ');
    }
    let container;

    logger.info(`Creating docker container for image=${workspace.settings.workspace_image}`);
    logger.info(`Exposed port: ${workspace.settings.workspace_port}`);
    logger.info(`Env vars: WORKSPACE_BASE_URL=/pl/workspace/${workspace.id}/container/`);
    logger.info(`User binding: ${config.workspaceJobsDirectoryOwnerUid}:${config.workspaceJobsDirectoryOwnerGid}`);
    logger.info(`Port binding: ${workspace.settings.workspace_port}:${workspace.launch_port}`);
    logger.info(`Volume mount: ${workspacePath}:${containerPath}`);
    logger.info(`Container name: ${localName}`);
    async.series([
        (callback) => {
            logger.info(`Creating directory ${workspaceJobPath}`);
            fs.mkdir(workspaceJobPath, { recursive: true }, (err) => {
                if (err && err.code !== 'EEXIST') {
                    /* Ignore the directory if it already exists */
                    ERR(err, callback); return;
                }
                callback(null);
            });
        },
        (callback) => {
            _workspaceFileChangeOwner(workspaceJobPath, (err) => {
                if (ERR(err, callback)) return;
                callback(null);
            });
        },
        (callback) => {
            docker.createContainer({
                Image: workspace.settings.workspace_image,
                ExposedPorts: {
                    [`${workspace.settings.workspace_port}/tcp`]: {},
                },
                Env: [
                    `WORKSPACE_BASE_URL=/pl/workspace/${workspace.id}/container/`,
                ],
                User: `${config.workspaceJobsDirectoryOwnerUid}:${config.workspaceJobsDirectoryOwnerGid}`,
                HostConfig: {
                    PortBindings: {
                        [`${workspace.settings.workspace_port}/tcp`]: [{'HostPort': `${workspace.launch_port}`}],
                    },
                    Binds: [`${workspacePath}:${containerPath}`],
                    // Copied directly from externalGraderLocal.js
                    Memory: 1 << 30, // 1 GiB
                    MemorySwap: 1 << 30, // same as Memory, so no access to swap
                    KernelMemory: 1 << 29, // 512 MiB
                    DiskQuota: 1 << 30, // 1 GiB
                    IpcMode: 'private',
                    CpuPeriod: 100000, // microseconds
                    CpuQuota: 90000, // portion of the CpuPeriod for this container
                    PidsLimit: 1024,
                },
                Cmd: args, // FIXME: proper arg parsing
                name: localName,
                Volumes: {
                    [containerPath]: {},
                },
            }, (err, newContainer) => {
                if (ERR(err, callback)) return;
                container = newContainer;

                sqldb.query(sql.update_load_count, {workspace_id: workspace.id, count: +1}, function(err, _result) {
                    if (ERR(err, callback)) return;
                    callback(null, container);
                });
            });
        }], (err) => {
            if (ERR(err, callback)) return;
            callback(null, container);
        });
}

function _createContainerWrapper(workspace, callback) {
    async.parallel({
        query: (callback) => {_queryUpdateWorkspaceHostname(workspace.id, workspace.launch_port, callback);},
        container: (callback) => {_createContainer(workspace, callback);},
    }, (err, results) => {
        if (ERR(err, callback)) return;
        workspace.container = results.container;
        callback(null, workspace);
    });
}

function _startContainer(workspace, callback) {
    workspace.container.start((err) => {
        if (ERR(err, callback)) return;
        callback(null, workspace);
    });
}

// Called by the main server the first time a workspace is used by a user
function initSequence(workspace_id, res) {
    logger.info(`Launching workspace_id=${workspace_id}`);

    const uuid = uuidv4();
    const workspace = {
        'id': workspace_id,
        'launch_uuid': uuid,
        'local_name': `workspace-${uuid}`,
        's3_name': `workspace-${workspace_id}`,
    };

    // send 200 immediately to prevent socket hang up from _pullImage()
    res.status(200).send(`Container for workspace ${workspace_id} initialized.`);

    async.waterfall([
        async () => {
            await sqldb.queryAsync(sql.set_workspace_launch_uuid, { workspace_id, uuid });
            return workspace;
        },
        _syncPullContainer,
        _getSettingsWrapper,
        _pullImage,
        _createContainerWrapper,
        _startContainer,
        _checkServer,
    ], function(err) {
        if (err) {
            logger.error(`Error for workspace_id=${workspace_id}: ${err}\n${err.stack}`);
            res.status(500).send(err);
        } else {
            sqldb.query(sql.update_workspace_launched_at_now, {workspace_id}, (err) => {
                if (ERR(err)) return;
                logger.info(`Container initialized for workspace_id=${workspace_id}`);
                const state = 'running';
                workspaceHelper.updateState(workspace_id, state);
            });
        }
    });
}

// Called by the main server when the user want to reset the file to default
function resetSequence(workspace_id, res) {
    async.waterfall([
        async () => { return await _getWorkspaceAsync(workspace_id); },
        _syncPullContainer,
    ], function(err) {
        if (err) {
            res.status(500).send(err);
        } else {
            res.status(200).send(`Code of workspace ${workspace_id} reset.`);
        }
    });
}

function gradeSequence(workspace_id, res) {
    async.waterfall([
        async () => {
            const workspace = await _getWorkspaceAsync(workspace_id);
            const workspaceSettings = await _getWorkspaceSettingsAsync(workspace_id);
            const timestamp = new Date().toISOString().replace(/[-T:.]/g, '-');
            const zipName = `workspace-${workspace_id}-${timestamp}.zip`;
            const zipPath = path.join(zipPrefix, zipName);

            return {
                workspace,
                workspaceSettings,
                workspaceDir: `${workspacePrefix}/${workspace.local_name}`,
                zipPath,
            };
        },
        async (locals) => {
            const archive = archiver('zip');
            locals.archive = archive;
            for (const file of locals.workspaceSettings.workspace_graded_files) {
                try {
                    const file_path = path.join(locals.workspaceDir, file);
                    await fsPromises.lstat(file_path);
                    archive.file(file_path, { name: file });
                    logger.info(`Sending ${file}`);
                } catch (err) {
                    logger.warn(`Graded file ${file} does not exist.`);
                    continue;
                }
            }
            return locals;
        },
        (locals, callback) => {
            /* Write the zip archive to disk */
            const archive = locals.archive;
            let output = fs.createWriteStream(locals.zipPath);
            output.on('close', () => {
                callback(null, locals);
            });
            archive.on('warning', (warn) => {
                logger.warn(warn);
            });
            archive.on('error', (err) => {
                ERR(err, callback);
            });
            archive.pipe(output);
            archive.finalize();
        },
    ], (err, locals) => {
        if (err) {
            logger.error(`Error in gradeSequence: ${err}`);
            res.status(500).send(err);
            try {
                fsPromises.unlink(locals.zipPath);
            } catch (err) {
                logger.error(`Error deleting ${locals.zipPath}`);
            }
        } else {
            res.attachment(locals.zipPath);
            res.status(200).sendFile(locals.zipPath, { root: '/' }, (_err) => {
                try {
                    fsPromises.unlink(locals.zipPath);
                } catch (err) {
                    logger.error(`Error deleting ${locals.zipPath}`);
                }
            });
        }
    });
}
