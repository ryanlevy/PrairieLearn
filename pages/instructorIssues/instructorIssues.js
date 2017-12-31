const ERR = require('async-stacktrace');
const _ = require('lodash');
const moment = require('moment');
const express = require('express');
const router = express.Router();

const error = require('../../lib/error');
const paginate = require('../../lib/paginate');
const sqldb = require('../../lib/sqldb');
const sqlLoader = require('../../lib/sql-loader');

const sql = sqlLoader.loadSqlEquiv(__filename);

const pageSize = 100;

router.get('/', function(req, res, next) {
    var params = {
        course_id: res.locals.course.id,
    };
    sqldb.query(sql.issues_count, params, function(err, result) {
        if (ERR(err, next)) return;
        if (result.rowCount != 2) return next(new Error('unable to obtain issue count, rowCount = ' + result.rowCount));
        res.locals.closedCount = result.rows[0].count;
        res.locals.openCount = result.rows[1].count;
        res.locals.issueCount = res.locals.closedCount + res.locals.openCount;

        _.assign(res.locals, paginate.pages(req.query.page, res.locals.issueCount, pageSize));

        var params = {
            course_id: res.locals.course.id,
            offset: (res.locals.currPage - 1) * pageSize,
            limit: pageSize,
            qid: req.query.qid,
        };
        sqldb.query(sql.select_issues, params, function(err, result) {
            if (ERR(err, next)) return;

            // Add human-readable relative dates to each row
            result.rows.forEach((row) => {
                row.relative_date = moment(row.formatted_date).from(row.now_date);
            });

            res.locals.rows = result.rows;
            res.locals.filterQid = req.query.qid;
            res.render(__filename.replace(/\.js$/, '.ejs'), res.locals);
        });
    });
});

router.post('/', function(req, res, next) {
    if (!res.locals.authz_data.has_instructor_edit) return next();
    if (req.body.__action == 'open') {
        let params = [
            req.body.issue_id,
            true, // open status
            res.locals.course.id,
            res.locals.authn_user.user_id,
        ];
        sqldb.call('issues_update_open', params, function(err, _result) {
            if (ERR(err, next)) return;
            res.redirect(req.originalUrl);
        });
    } else if (req.body.__action == 'close') {
        let params = [
            req.body.issue_id,
            false, // open status
            res.locals.course.id,
            res.locals.authn_user.user_id,
        ];
        sqldb.call('issues_update_open', params, function(err, _result) {
            if (ERR(err, next)) return;
            res.redirect(req.originalUrl);
        });
    } else if (req.body.__action == 'close_all') {
        let params = [
            false, // open status
            res.locals.course.id,
            res.locals.authn_user.user_id,
        ];
        sqldb.call('issues_update_open_all', params, function(err, _result) {
            if (ERR(err, next)) return;
            res.redirect(req.originalUrl);
        });
    } else {
        return next(error.make(400, 'unknown __action', {locals: res.locals, body: req.body}));
    }
});

module.exports = router;
