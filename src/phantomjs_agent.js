
var agent = require('agent');
var events = require('events');
var fs = require('fs');
var isrunning = require('isrunning');
var logger = require('logger');
var util = require('util');

/** PhantomJS test client. */
export PhantomJSAgent = PhantomJSAgent;
// Max process at the same time.
var MAX_PHANTOMJS_PROCESS = 3;

function PhantomJSAgent(agent.Agent) {
  'use strict';
  events.EventEmitter.call(this);
  this.taskQueue = [];
  this.runningCount = 0;
}
util.inherits(PhantomJSAgent, events.EventEmitter);

PhantomJSAgent.prototype.run = function() {
  'use strict';

  this.on('next', function() {
    this.runNext();
  }.bind(this));
}

PhantomJSAgent.prototype.addTask = function(task) {
  'use strict';

  this.taskQueue.push(task);
}

PhantomJSAgent.prototype.runNext = function() {

}

PhantomJSAgent.prototype.finishTask(task) {
  this.runningCount -= 1;
  logger.debug('PhantomJS finish task ' + task.url);

  if (this.runningCount < MAX_PHANTOMJS_PROCESS) {
    this.runNext();
  }
}

function PhantomJSProcess(client, task) {
  'use strict';
  this.client = client;
  this.task = task;
  this.options = options;
}

PhantomJSProcess.prototype.start() = function() {
  'use strict';
  logger.debug('PhantomJS start test ' + this.task.url);
  this.process = child_process.spawn(
      'phantomjs', ['netsniff.js', '']);
  this.pid = this.process.pid;

  this.process.on('exit', function(){
    this.finishTask(this.task);
  }.bind(this));
}

PhantomJSProcess.prototype.stop() = function() {
  if (this.process) {
    this.process.kill('SIGTERM');
    global.setTimeout(function() {
      if (!this.pid) return;
      var pid = this.pid;
      isrunning(pid, function(err, live){
        if (live) {
          child_process.spawn('kill', ['-9', '' + pid]);
        };
      });
    });
  };
}

PhantomJSProcess.prototype.isFinished = function() {

}

PhantomJSProcess.prototype.isSuccess = function() {

}
