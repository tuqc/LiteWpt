/**
 * The program outputs a HAR data and a screenshot file from a given
 * web url.
 *
 * Notice: This script only could run in phantomjs which is a headless WebKit with
 * Javascript API.
 */

if (!Date.prototype.toISOString) {
  Date.prototype.toISOString = function () {
    function pad(n) { return n < 10 ? '0' + n : n; }
    function ms(n) { return n < 10 ? '00'+ n : n < 100 ? '0' + n : n }
    return this.getFullYear() + '-' +
        pad(this.getMonth() + 1) + '-' +
        pad(this.getDate()) + 'T' +
        pad(this.getHours()) + ':' +
        pad(this.getMinutes()) + ':' +
        pad(this.getSeconds()) + '.' +
        ms(this.getMilliseconds()) + 'Z';
  }
}

function createHAR(address, title, startTime, resources)
{
  var entries = [];

  resources.forEach(function (resource) {
    var request = resource.request,
      startReply = resource.startReply,
      endReply = resource.endReply;

  if (!request) {
    return;
  }

  // Exclude Data URI from HAR file because
  // they aren't included in specification
  if (request.url.match(/(^data:image\/.*)/i)) {
    return;
  }

  if (!startReply || !endReply) {
    //Process no reply request.
    var errorCode = 12999;
    var bodySize = -1;
    var wait = -1;
    var receive = -1;
    if (startReply) {
      errorCode = 12998;
      bodySize = startReply.bodySize;
      wait = startReply.time - request.time;
      receive = page.endTime - startReply.time;
    }
    entries.push({
        startedDateTime: request.time.toISOString(),
        time: page.endTime - request.time,
        request: {
          method: request.method,
          url: request.url,
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: request.headers,
          queryString: [],
          headersSize: -1,
          bodySize: -1
        },
        response: {
          status: errorCode,
          statusText: '',
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: [],
          redirectURL: "",
          headersSize: -1,
          bodySize: bodySize,
          content: {
            size: bodySize,
            mimeType: ''
          }
        },
        cache: {},
        timings: {
          blocked: 0,
          dns: -1,
          connect: -1,
          send: 0,
          wait: wait,
          receive: receive,
          ssl: -1
        },
        pageref: address
    });
  } else {
    // For normal request.
    entries.push({
        startedDateTime: request.time.toISOString(),
        time: endReply.time - request.time,
        request: {
          method: request.method,
          url: request.url,
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: request.headers,
          queryString: [],
          headersSize: -1,
          bodySize: -1
        },
        response: {
          status: endReply.status,
          statusText: endReply.statusText,
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: endReply.headers,
          redirectURL: "",
          headersSize: -1,
          bodySize: startReply.bodySize,
          content: {
            size: startReply.bodySize,
            mimeType: endReply.contentType
          }
        },
        cache: {},
        timings: {
          blocked: 0,
          dns: -1,
          connect: -1,
          send: 0,
          wait: startReply.time - request.time,
          receive: endReply.time - startReply.time,
          ssl: -1
       },
       pageref: address
    });
  }
});

return {
    log: {
      version: '1.2',
      creator: {
        name: "PhantomJS",
        version: phantom.version.major + '.' + phantom.version.minor +
            '.' + phantom.version.patch
      },
      pages: [{
          startedDateTime: startTime.toISOString(),
          id: address,
          title: title,
          pageTimings: {
            onLoad: page.endTime - page.startTime
          }
     }],
     entries: entries
    }
  };
}

var page = require('webpage').create();
var system = require('system');
var fs = require('fs');

if (system.args.length !== 4) {
  console.log('Usage: netsniff.js <some URL> <HAR path> <screenshot path>');
  phantom.exit(1);
} else {
  var harPath = system.args[2];
  var screenshotPath = system.args[3];

  page.address = system.args[1];
  page.resources = [];

  page.onLoadStarted = function () {
    page.startTime = new Date();
  };

  page.onResourceRequested = function (req) {
    page.resources[req.id] = {
      request: req,
      startReply: null,
      endReply: null
    };
  };

  page.onResourceReceived = function (res) {
    if (res.stage === 'start') {
      page.resources[res.id].startReply = res;
    }
    if (res.stage === 'end') {
      page.resources[res.id].endReply = res;
    }
  };

  page.viewportSize = {width: 1024, height: 800};
  page.open(page.address, function (status) {
    var har;
    if (status !== 'success') {
      console.log('FAIL to load the address');
      phantom.exit(1);
    } else {
      page.endTime = new Date();
      page.title = page.evaluate(function () {
        return document.title;
      });
      har = createHAR(page.address, page.title, page.startTime, page.resources);
      fs.write(harPath, JSON.stringify(har, undefined, 4), 'w');
      page.render(screenshotPath);
      phantom.exit();
    }
  });
}
