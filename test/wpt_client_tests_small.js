/******************************************************************************
Copyright (c) 2012, Google Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    * Neither the name of Google, Inc. nor the names of its contributors
      may be used to endorse or promote products derived from this software
      without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
******************************************************************************/

var events = require('events');
var http = require('http');
var logger = require('logger');
var should = require('should');
var sinon = require('sinon');
var Stream = require('stream');
var test_utils = require('./test_utils.js');
var wpt_client = require('wpt_client');
var Zip = require('node-zip');

var WPT_SERVER = process.env.WPT_SERVER || 'http://localhost:8888';
var LOCATION = process.env.LOCATION || 'TEST';


/**
 * All tests are synchronous, do NOT use Mocha's function(done) async form.
 *
 * The synchronization is via:
 * 1) sinon's fake timers -- timer callbacks triggered explicitly via tick().
 * 2) stubbing out anything else with async callbacks, e.g. process or network.
 */
describe('wpt_client small', function() {
  'use strict';

  var sandbox;

  beforeEach(function() {
    sandbox = sinon.sandbox.create();
    test_utils.fakeTimers(sandbox);
    // Re-create stub process for each test to avoid accumulating listeners.
    wpt_client.process = new events.EventEmitter();
  });

  afterEach(function() {
    // Call unfakeTimers before verifyAndRestore, which may throw.
    test_utils.unfakeTimers(sandbox);
    sandbox.verifyAndRestore();
    wpt_client.process = process;
  });

  it('should call client.finishRun_ when job done', function() {
    var client = new wpt_client.Client({serverUrl: 'base',
        location: 'location', apiKey: 'apiKey', jobTimeout: 0});
    sandbox.mock(client).expects('finishRun_').once();

    var job = new wpt_client.Job(client, {'Test ID': 'ABC', runs: 1});
    job.runFinished();
  });

  it('should be able to timeout a job', function() {
    var client = new wpt_client.Client({serverUrl: 'server',
        location: 'location', jobTimeout: 2});
    var isTimedOut = false;
    test_utils.stubLog(sandbox, function(
         levelPrinter, levelName, stamp, source, message) {
      return ('job timeout: gaga' === message);
    });
    client.onJobTimeout = function() {
      logger.info('Caught timeout in test');
      isTimedOut = true;
    };
    client.onStartJobRun = function() {};  // Never call runFinished => timeout.

    client.processJobResponse_('{"Test ID": "gaga", "runs": 2}');
    sandbox.clock.tick(1);
    should.ok(!isTimedOut);
    sandbox.clock.tick(1);
    should.ok(isTimedOut);
  });

  it('should call onStartJobRun when a new job is processed', function() {
    var client = new wpt_client.Client({serverUrl: 'url'});
    client.onStartJobRun = function() {};
    var startJobRunSpy = sandbox.spy(client, 'onStartJobRun');

    client.processJobResponse_('{"Test ID": "gaga", "runs": 2}');
    should.ok(startJobRunSpy.calledOnce);
  });

  it('should do a http get request to the correct url when requesting next job',
      function() {
    sandbox.stub(http, 'get', function() {
      return new events.EventEmitter();
    });

    var client = new wpt_client.Client({serverUrl: 'http://server',
        location: 'Test'});
    client.runNextJob();

//    should.ok(http.get.calledOnce);
//    should.equal(http.get.firstCall.args[0].href,
//        'http://server/work/getwork.php?location=Test&f=json');
  });

});
