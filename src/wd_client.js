var task_manager = require('task_manager');

var DEFAULT_TASK_TIMEOUT = 60000; // 60 seconds
// Wait for 5 seconds before force-killing
var WD_SERVER_EXIT_TIMEOUT = 5000;

function WebDriverClient(clientMgr, task, flags) {
  'use strict';
  this.clientMgr_ = clientMgr;
  this.task_ = task;
  this.flags_ = flags;
  this.taskDef_ = task.taskDef_;

  this.taskTimeout = task.timeout || DEFAULT_TASK_TIMEOUT;
  this.app_ = webdriver.promise.Application.getInstance();
  process_utils.injectWdAppLogging('main app', this.app_);

}

/**
 * Performs one run of a job in a wd_server module that runs as a child process.
 *
 */
WebDriverClient.prototype.run = function() {
  'use strict';
  exports.process.on('uncaughtException',
                     this.onUncaughtException_.bind(this));

  if (!this.wdServer_) {
    this.startWdServer_();
    this.wdServer_.on('message', function(ipcMsg) {
      logger.debug('got IPC: %s', ipcMsg.cmd);
      if ('done' === ipcMsg.cmd || 'error' === ipcMsg.cmd) {
        if ('error' === ipcMsg.cmd) {
          this.task.setError(ipcMsg.e);
          job.error = ipcMsg.e;
        }
        this.scheduleProcessDone_(ipcMsg, job);
        this.scheduleCleanup_();
      }
    }.bind(this));
  }
  if (this.taskDef.tcpdump) {
      this.clientMgr_.startTCPDump();
  }

  var script = this.taskDef.script;
  var url = this.taskDef.url;
  this.scheduleNoFault_('Send IPC "run"', function() {
    var message = {
        cmd: 'run',
        options: {browserName: this.taskDef_.browser},
        exitWhenDone: true,
        script: script,
        url: url,
        timeout: this.taskDef.timeout || DEFAULT_TASK_TIMEOUT
      };
    if (this.taskDef_.proxyPacUrl) {
      message.proxyPacUrl = this.taskDef_.proxyPacUrl;
    } else if (this.taskDef_.proxyServer) {
      message.proxyServer = this.taskDef_.proxyServer;
    }
    var key;
    for (key in this.flags_) {
      if (!message[key]) {
        message[key] = this.flags_[key];
      }
    }
    this.wdServer_.send(message);
  }.bind(this));
};


/**
 * @param {Object} abort test job.
 * @private
 */
WebDriverClient.prototype.taskTimeout_ = function() {
  'use strict';
  if (this.wdServer_) {
    this.scheduleNoFault_('Send IPC "abort"', function() {
      this.wdServer_.send({cmd: 'abort'});
    }.bind(this));
  }
  if (this.taskDef_.tcpdump) this.clientMgr_.stopTCPDump();
  this.scheduleNoFault_('Timed out job finished',
                        (this.clientMgr_.runFinished(false, true)).bind(this));
  this.scheduleCleanup_();
};


/**
 * Finish task.
 * @private
 */
WebDriverClient.prototype.finishRun_ = function() {
  'use strict';
  logger.info('Finished run task %s.', this.task.id);
};


/**
 * Unhandled exception in the client process.
 *
 * @param {Error} e error object.
 * @private
 */
WebDriverClient.prototype.onUncaughtException_ = function(e) {
  'use strict';
  logger.critical('Unhandled exception in the client: %s', e);
  this.task.setError(e);
  // TODO
};

/**
 * @param {string=} description debug title.
 * @param {Function} f the function to schedule.
 * @return {webdriver.promise.Promise} the scheduled promise.
 * @private
 */
WebDriverClient.prototype.scheduleNoFault_ = function(description, f) {
  'use strict';
  return process_utils.scheduleNoFault(this.app_, description, f);
};

/**
 * Starts a child process with the wd_server module.
 *
 * @private
 */
WebDriverClient.prototype.startWdServer_ = function() {
  'use strict';
  if (this.wdServer) return;
  this.wdServer_ = child_process.fork('./src/wd_server.js',
      [], {env: process.env});
  this.wdServer_.on('exit', function(code, signal) {
    logger.info('wd_server child exit code %s signal %s', code, signal);
    this.wdServer_ = undefined;
  }.bind(this));
};

/**
 * Processes job results, including failed jobs.
 *
 * @param {Object} ipcMsg a message from the wpt client.
 * @param {Job} job the job with results.
 * @private
 */
WebDriverClient.prototype.scheduleProcessDone_ = function(ipcMsg) {
  'use strict';
  this.scheduleNoFault_('Process job results', function() {
    if (ipcMsg.devToolsMessages) {
      var devMessage = JSON.stringify(ipcMsg.devToolsMessages);
      this.task.addResultFile(task_manager.Task.ResultFileName.DEVTOOLS_MSG,
                              devMessage);
      var harJson = har.parseFromText(devMessage);
      this.task.processHAR(harJson);
      this.task.addResultFile(task_manager.Task.ResultFileName.HAR, harJson);
    }
    if (ipcMsg.screenshots && ipcMsg.screenshots.length > 0) {
      var index = 0;
      ipcMsg.screenshots.forEach(function(screenshot) {
        logger.debug('Adding screenshot %s', screenshot.fileName);
        var contentBuffer = new Buffer(screenshot.base64, 'base64');
        var fileName = task_manager.Task.ResultFileName.SCREENSHOT;
        if (index >= 1) {
          filename = task_manager.Task.ResultFileName.SCREENSHOT + '_' + index;
        }
        this.task.addResultFile(fileName, contentBuffer);
        index += 1;
      });
    }
  }.bind(this));
};


/**
 * Kill the wdServer and traffic shaper.
 *
 * @private
 */
WebDriverClient.prototype.scheduleCleanup_ = function() {
  'use strict';
  if (this.wdServer_) {
    process_utils.scheduleWait(this.wdServer_, 'wd_server',
          WD_SERVER_EXIT_TIMEOUT).then(function() {
      // This assumes a clean exit with no zombies
      this.wdServer = undefined;
    }.bind(this), function() {
      process_utils.scheduleKill(this.app_, 'Kill wd_server',
          this.wdServer_);
      this.app_.schedule('undef wd_server', function() {
        this.wdServer_ = undefined;
      }.bind(this));
    }.bind(this));
  }
  // TODO kill dangling child processes
};
