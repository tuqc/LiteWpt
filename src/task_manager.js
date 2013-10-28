
var events = require('events');
var fs = require('fs');
var isrunning = require('isrunning');
var logger = require('logger');
var util = require('util');

// Sanity limit. Max tcp dump time to prevent too large dump file
var MAX_TCP_DUMP_TIME = 30 * 1000;
// Max days job data will be kept on disk.
var MAX_JOB_KEEP_DAYS = 5; // 5 days
// Max test running at the same time.
var DEFAULT_COCURRENT = 2;
// Default directory of result file.
var DEFAULT_BASE_RESULT_DIR = './result/';

/** Abstract agent class. */
export TaskManager = TaskManager;
/** Public task class. */
export Task = Task;

function TaskManager(name, clientClass, maxConcurrent) {
  'use strict';
  events.EventEmitter.call(this);
  this.name = name;
  this.clientClass = clientClass;
  this.maxConcurrent = maxConcurrent || DEFAULT_COCURRENT;
  // Pening taskdef queue.
  this.pendingQueue = [];
  // Finished taskdef queue.
  this.finishedQueue = [];
  // Running task queue.
  this.runningQueue = [];
}
util.inherits(TaskManager, events.EventEmitter);

TaskManager.prototype.run = function() {
  'use strict';
  throw new Error('Operation not implement.');

  this.on('runnext', function() {
    this.runNext();
  }.bind(this));
};

/**
 * Add task for test.
 * @param {Object} task
 */
TaskManager.prototype.addTask = function(taskDef) {
  'use strict';
  this.pendingQueue.push(taskDef);
  this.emit('runnext');
};

/**
 * Finish task.
 * @param  {TaskDef} taskDef
 */
TaskManager.prototype.finishTask = function(task) {
  fs.writeFile(path, JSON.stringify(task.taskDef), (function(err) {
    this.finishedQueue.push(task.taskDef);
  }).bind(this));


};

TaskManager.prototype.runNextTask = function() {
  if (this.runningQueue.length >= this.maxConcurrent) {
    logger.debug('%s too many task running now: %s',
                 this.name, this.runningQueue.length);
    return;
  }

  var taskDef = this.pendingQueue.shift();
  if (taskDef) {
    logger.info('%s run job: %s', this.name , taskDef.id);
    var task = new Task(taskDef);
    this.runningQueue.push(task);
    var client = new this.clientClass(this, task);
    client.run();
  }
  return taskDef;
};

TaskManager.prototype.getBaseResultDir = function() {
  return DEFAULT_BASE_RESULT_DIR;
};

TaskManager.prototype.finishTask(task) {
  this.runningQueue.remove(task.taskDef);
  logger.debug('%s Finish task %s', this.name, task.id);

  if (this.runningQueue.length < this.maxConcurrent) {
    this.emit('runnext');
  }

    if (this.tcpdump) this.stopTCPDump();
  if (isRunFinished && this === this.client_.currentTask_) {
    this.taskDef.endTimestamp = moment().unix();
    this.finishedQueue.push(common_utils.cloneObject(this.taskDef));
    if (this.finishedQueue.length > 1000) {
      this..finishedQueue.shift();
    }

    this.resultFiles.push(
        new ResultFile(ResultFile.ContentType.JSON,
                      'task.json', JSON.stringify(this.taskDef)));
    var jobResult = new TaskResult(this.id, this.client_.resultDir);

    jobResult.writeResult(this.resultFiles, (function() {
      this.resultFiles = [];
      this.client_.finishRun_(this, isRunFinished);
    }).bind(this));
  } else {
    this.client_.finishRun_(this, isRunFinished);
  }
};

/**
 * Start tcp dump raw binary meesgae
 */
TaskManager.prototype.startTCPDump = function(task) {
  //var jobResult = this.client_.getTaskResult(this.id);
 // this.tcpdumpRawFile = jobResult.getResultFile('tcpdump.raw');
  this.dumpFilePath = path.join(task.getResultDir(), Task.ResultFile.TCPDUMP);
  jobResult.mkdirp((function(err) {
    this.tcpdumpProcess = child_process.spawn(
        'tcpdump', ['-w', this.dumpFilePath]);
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
    }).bind(this), 30 * 1000);
    this.tcpdumpProcess = undefined;
  }
};


function Task(taskDef) {
  'use strict';
  this.taskDef = taskDef;
  if (!taskDef.id) {
    taskDef.id = Task.generateID();
  }
  this.id = taskDef.id;
  this.taskResult = {};
  this.error = undefined;
  thi.resultFiles = [];
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

Task.prototype.setError = function(error) {
  this.error = error;
};

Task.prototype.addResultFile = function(filename, content) {
  this.resultFiles.push({filename: filename, content: content});
}

/**
 * Get task result directory.
 * @return {String}
 */
Task.prototype.getResultDir = function() {
  'use strict';
  return Task.deduceResultDir(this.id);
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

Task.ResultFileName = Object.freeze({
  TASKDEF: 'task.json',
  TCPDUMP: 'tcpdump.raw',
  SCREENSHOT: 'screen.png',
  HAR: 'har.json',
  DEVTOOLS_MSG: 'devtools.json'
});
