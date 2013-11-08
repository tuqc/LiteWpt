var async = require('async');
var child_process = require('child_process');
var crypto = require('crypto');
var common_utils = require('common_utils');
var events = require('events');
var fs = require('fs');
var isrunning = require('is-running');
var logger = require('logger');
var path = require('path');
var mkdirp = require('mkdirp');
var moment = require('moment');
var util = require('util');
var process_utils = require('process_utils');
var system_commands = require('system_commands');

// Sanity limit. Max tcp dump time to prevent too large dump file
var MAX_TCP_DUMP_TIME = 30 * 1000;
// Max days job data will be kept on disk.
var MAX_JOB_KEEP_DAYS = 5; // 5 days
// Max test running at the same time.
var DEFAULT_COCURRENT = 2;
// Default directory of result file.
var DEFAULT_BASE_RESULT_DIR = './result/';
// Default max test time, will kill timeout test.
var DEFAULT_TEST_TIMEOUT = 2 * 60 * 1000;  // 3 minutes.

exports.DEFAULT_BASE_RESULT_DIR = DEFAULT_BASE_RESULT_DIR;

/** Abstract agent class. */
exports.TaskManager = TaskManager;
/** Public task class. */
exports.Task = Task;

function TaskManager(name, clientClass, flags) {
  'use strict';
  events.EventEmitter.call(this);
  this.name = name;
  this.clientClass = clientClass;
  this.maxConcurrent = DEFAULT_COCURRENT;
  // Pening task queue.
  this.pendingQueue = [];
  // Finished task queue.
  this.finishedQueue = [];
  // Running task queue.
  this.runningQueue = [];
  this.flags_ = flags;
}
util.inherits(TaskManager, events.EventEmitter);

TaskManager.prototype.run = function() {
  'use strict';

  process.on('uncaughtException', function(e) {
    if (e) {
      logger.warn(e.stack);
    }
  });

  this.on('runnext', function() {
    this.runNextTask();
  }.bind(this));
};

/**
 * Add task for test.
 * @param {Object} task
 */
TaskManager.prototype.addTask = function(taskDef) {
  'use strict';
  if (taskDef.gid) {
    // Gid short for group id, Here we don't allow 2 or more tasks
    // with the same gid in the pending list.
    var found = false;
    for (var i = this.pendingQueue.length - 1; i >= 0; i--) {
      var td = this.pendingQueue[i];
      if (td.gid && td.gid == taskDef.gid) {
        found = true;
        break;
      }
    };

    if (found) {
      return {error: true, message: 'Duplicate gid.'};
    }
  };

  var task = new Task(taskDef);
  this.pendingQueue.push(task);
  this.emit('runnext');
  return {id: task.id, position: this.pendingQueue.length};
};


TaskManager.prototype.findTask = function(tid) {
  for (var i = 0; i < this.pendingQueue.length; i++) {
    if (this.pendingQueue[i].id == tid) {
      return this.pendingQueue[i];
    }
  };

  for (var i = 0; i < this.runningQueue.length; i++) {
    if (this.runningQueue[i].id == tid) {
      return this.runningQueue[i];
    }
  };

  for (var i = 0; i < this.finishedQueue.length; i++) {
    if (this.finishedQueue[i].id == tid) {
      return this.finishedQueue[i];
    }
  };

  return undefined;
}


TaskManager.prototype.runNextTask = function() {
  if (this.runningQueue.length >= this.maxConcurrent) {
    logger.debug('%s too many task running now: %s',
                 this.name, this.runningQueue.length);
    return;
  }

  var task = this.pendingQueue.shift();
  if (task) {
    logger.info('%s run job: %s', this.name , task.id);
    task.taskDef.startTimestamp = moment().unix();
    this.runningQueue.push(task);
    task.setStatus(Task.Status.RUNNING);
    var client = new this.clientClass(this, task, this.flags_);
    client.run();

    //Abort test if timeout, 45 second.
    global.setTimeout(function() {
      if (!client.task.isFinished()) {
        client.abort();
      }
    }.bind(client), task.taskDef.timeout || DEFAULT_TEST_TIMEOUT);
  }
};

TaskManager.prototype.getBaseResultDir = function() {
  return DEFAULT_BASE_RESULT_DIR;
};

TaskManager.prototype.finishTask = function(task) {
  logger.info('%s Finish task %s', this.name, task.id);
  var index = this.runningQueue.indexOf(task);
  if (index > -1) {
    this.runningQueue.splice(index, 1);
  } else {
    return;
  }

  if (task.taskDef.tcpdump) task.stopTCPDump();
  task.taskDef.endTimestamp = moment().unix();

  task.setStatus(Task.Status.FINISHED);

  // Write result files and clear it.
  task.flushResult();

  // Add to finished task queue.
  this.finishedQueue.push(task);
  if (this.finishedQueue.length > 1000) {
    this.finishedQueue.shift();
  }

  // Run next.
  if (this.runningQueue.length < this.maxConcurrent) {
    this.emit('runnext');
  }
};

function Task(taskDef) {
  'use strict';
  this.taskDef = taskDef;
  if (!this.taskDef.id) {
    this.taskDef.id = Task.generateID(this.taskDef);
  }
  this.id = this.taskDef.id;
  this.taskResult = {};
  this.error = undefined;
  this.resultFiles = [];
  this.status = Task.Status.PENDING;
}
/** Public class. */
exports.Task = Task;

/**
 * Generate unique job id in specific format.
 * The can find the job result directory according the id.
 *
 * @param {Object} job input job.
 * @return {String} unique job id.
 */
Task.generateID = function(taskDef) {
  var randStr = crypto.randomBytes(2).toString('hex');
  var dateStr = moment().format('YYYYMMDDHHmm');
  return dateStr + '_' + randStr;
};

Task.prototype.setStatus = function(status) {
  this.status = status;
}

/**
 * Deduce test reuslt directory from task id.
 * @param  {String} idStr
 * @return {String}
 */
Task.deduceResultDir = function(idStr) {
  var dateStr = idStr.split('_')[0];
  var date = moment(dateStr, 'YYYYMMDDHHmm');
  var align = function(num) {
    return num >= 10 ? '' + num : '0' + num;
  };
  var finalPath = path.join(DEFAULT_BASE_RESULT_DIR,
                            align(date.year()), align(date.month() + 1),
                            align(date.date()), align(date.hour()),
                            idStr);
  return finalPath;
};

Task.deduceReusltFilePath = function(tid, filename) {
  var resultDir = Task.deduceResultDir(tid);
  return path.join(resultDir, filename);
};

Task.prototype.setError = function(error) {
  this.error = error;
};

Task.prototype.isFinished = function() {
  return (this.status === Task.Status.FINISHED ||
          this.status === Task.Status.ABORTED);
}

Task.prototype.flushResult = function(callback) {
  logger.info('Flush task %s(%s) result to %s',
              this.id, this.status, this.getResultDir());

  if (this.status == Task.Status.ABORTED) {
    this.taskDef.success = false;
    this.taskDef.abort = true;
  } else {
    if (this.resultFiles.length > 0) {
      this.taskDef.success = true;
    } else {
      this.taskDef.success = false;
    }
  }
  this.addResultFile(Task.ResultFileName.TASKDEF,
                     JSON.stringify(this.taskDef,undefined, 4));

  // Write file to disk.
  var writeFile = (function(resultFile, fn) {
    var filePath = this.getResultFilePath(resultFile.filename);
    logger.info('Write %s to %s', resultFile.filename, filePath);
    fs.writeFile(filePath, resultFile.content, function(err) {
      fn(err);
      resultFile.content = undefined;
    });
  }).bind(this);

  mkdirp(this.getResultDir(), (function(err) {
    if (err) {
      logger.error(err);
    }
    // Write result files
    async.each(this.resultFiles, writeFile, function(err) {
      if (err) {
        logger.error('Write file error. %s', err);
      }
      this.resultFiles = undefined;
      if (callback) {
        callback();
      }
    }.bind(this));
  }).bind(this));
};

Task.prototype.addResultFile = function(filename, content) {
  if (filename && content) {
    logger.info('Task %s add result %s, len=%s',
                this.id, filename, content.length);
    this.resultFiles.push({filename: filename, content: content});
  } else {
    logger.warn('Task %s add empty file %s', this.id, filename);
  }
};

/**
 * Get task result directory.
 * @return {String}
 */
Task.prototype.getResultDir = function() {
  'use strict';
  return Task.deduceResultDir(this.id);
};

Task.prototype.getResultFilePath = function(filename) {
  return path.join(this.getResultDir(), filename);
};

/**
 * Process HAR object after parsed.
 *
 * @param {Object} harJson parsed HAR.
 */
Task.prototype.processHAR = function(harJson) {
  'use strict';
  if (harJson && harJson.log.pages.length > 0 &&
      harJson.log.entries.length > 0) {
    this.taskDef.success = true;
  } else {
    this.taskDef.success = false;
  }
};

/**
 * Start tcp dump raw binary, it could kill himself after timeout.
 */
Task.prototype.startTCPDump = function() {
  //Check if tcpdump already running.
  if (this.tcpdumpProcess) {
    return;
  }
  var dumpFilePath = this.getResultFilePath(Task.ResultFileName.TCPDUMP);
  logger.info('Start tcp dump for %s to %s', this.id, dumpFilePath);
  this.tcpdumpProcess = child_process.spawn('tcpdump', ['-w', dumpFilePath]);
  this.tcpdumpPid = this.tcpdumpProcess.pid;

  // Stop the tcpdump when timeout.
  global.setTimeout((function() {
    this.stopTCPDump();
  }).bind(this), MAX_TCP_DUMP_TIME);
};

/**
 * Stop tcpdump process.
 */
Task.prototype.stopTCPDump = function() {
  logger.info('Stop tcp dump for %s', this.id);
  if (this.tcpdumpProcess) {
    this.tcpdumpProcess.kill('SIGTERM');
    global.setTimeout((function() {
      if (!this.tcpdumpPid) {
        return;
      }
      var pid = this.tcpdumpPid;
      // Double check, kill it if process is live.
      isrunning(pid, function(err, live) {
        if (live) {
          child_process.spawn('kill', ['-9', '' + pid])
        }
      });
      this.tcpdumpProcess = undefined;
    }).bind(this), 30 * 1000);
  }
};

Task.Status = Object.freeze({
  RUNNING: 'running',
  PENDING: 'pending',
  FINISHED: 'finished',
  ABORTED: 'aborted'
});

Task.ResultFileName = Object.freeze({
  TASKDEF: 'task.json',
  TCPDUMP: 'tcpdump.raw',
  SCREENSHOT: 'screen.png',
  HAR: 'har.json',
  DEVTOOLS_MSG: 'devtools.json'
});
