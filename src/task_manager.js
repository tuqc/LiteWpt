var async = require('async');
var crypto = require('crypto');
var common_utils = require('common_utils');
var events = require('events');
var fs = require('fs');
var isrunning = require('is-running');
var logger = require('logger');
var path = require('path');
var moment = require('moment');
var util = require('util');
var process_utils = require('process_utils');
var system_commands = require('system_commands');

// Sanity limit. Max tcp dump time to prevent too large dump file
var MAX_TCP_DUMP_TIME = 30 * 1000;
// Max days job data will be kept on disk.
var MAX_JOB_KEEP_DAYS = 5; // 5 days
// Max test running at the same time.
var DEFAULT_COCURRENT = 1;
// Default directory of result file.
var DEFAULT_BASE_RESULT_DIR = './result/';

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
    for (var i = pendingQueue.length - 1; i >= 0; i--) {
      var td = pendingQueue[i];
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
  }

  var task = this.pendingQueue.shift();
  if (task) {
    logger.info('%s run job: %s', this.name , task.id);
    this.runningQueue.push(task);
    task.setStatus(Task.Status.RUNNING);
    var client = new this.clientClass(this, task, this.flags_);
    client.run();
  }
};

TaskManager.prototype.getBaseResultDir = function() {
  return DEFAULT_BASE_RESULT_DIR;
};

TaskManager.prototype.finishTask = function(task) {
  this.runningQueue.remove(task);
  logger.debug('%s Finish task %s', this.name, task.id);

  task.taskDef.endTimestamp = moment().unix();

  // Write the task.json
  fs.writeFile(path, JSON.stringify(task.taskDef), (function(err) {
    this.finishedQueue.push(task.taskDef);
  }).bind(this));

  if (this.tcpdump) this.stopTCPDump();

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

/**
 * Start tcp dump raw binary meesgae
 */
TaskManager.prototype.startTCPDump = function(task) {
  //Check if tcpdump already running.
  if (this.tcpdumpProcess) {
    return;
  }
  var dumpFilePath = path.join(task.getResultDir(), Task.ResultFile.TCPDUMP);
  jobResult.mkdirp((function(err) {
    this.tcpdumpProcess = child_process.spawn(
        'tcpdump', ['-w', dumpFilePath]);
    this.tcpdumpPid = this.tcpdumpProcess.pid;
    // Stop the tcpdump when timeout.
    global.setTimeout((function() {
      this.stopTCPDump();
    }).bind(this), MAX_TCP_DUMP_TIME);
  }).bind(this));
};

/**
 * Stop tcpdump process.
 */
TaskManager.prototype.stopTCPDump = function() {
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
  var path = util.format('%s/%s/%s/%s/%s/%s', this.baseDir,
                         align(date.year()), align(date.month() + 1),
                         align(date.date()), align(date.hour()),
                         this.id);
  return path;
};

Task.deduceReusltFilePath = function(tid, filename) {
  var resultDir = Task.deduceResultDir(tid);
  return path.join(resultDir, filename);
};

Task.prototype.setError = function(error) {
  this.error = error;
};

Task.prototype.flushResult = function(callback) {

  var writeFile = (function(resultFile, fn) {
    // Write File
    var filePath = this.getResultFilePath(resultFile.filename);
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
    });
  }).bind(this));
};

Task.prototype.addResultFile = function(filename, content) {
  this.resultFiles.push({filename: filename, content: content});
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

Task.Status = Object.freeze({
  RUNNING: 'running',
  PENDING: 'pending',
  FINISHED: 'finished'
});

Task.ResultFileName = Object.freeze({
  TASKDEF: 'task.json',
  TCPDUMP: 'tcpdump.raw',
  SCREENSHOT: 'screen.png',
  HAR: 'har.json',
  DEVTOOLS_MSG: 'devtools.json'
});
