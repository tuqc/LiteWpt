
var events = require('events');
var util = require('util');
var url = require('url');

exports.parseFromMessages = parseFromMessages;
exports.parseFromText = parseFromText;

function parseFromText(messageText) {
  var messages = JSON.parse(messageText);
  return parseFromMessages(messages);
}

function parseFromMessages(messages) {
  var har = {
    'log': {
      'version': '1.2',
      'creator': {
        'name': 'LiteWpt',
        'version': '1.0'
      },
      'pages': [],
      'entries': [],
    }
  };

  var frameIds = {};
  var pages = [];
  var pageCount = 0;
  for (var i in messages) {
    var message = messages[i];
    if (message.params.frameId && message.params.documentURL) {
      var frameId = message.params.frameId;
      if (!(frameId in frameIds)) {
        var page = new Page('page_1_' + pageCount, message.params.documentURL, frameId);
        pages.push(page);
        frameIds[frameId] = page;
        pageCount ++;
      }
    }
  }

  var pageIndex = 0;
  for (var i in messages) {
    var message = messages[i];
    var curPage = pages[pageIndex];
    if (message.params.frameId && message.params.frameId !== curPage.frameId) {
      pageIndex++;
      curPage = pages[pageIndex];
    }
    if (curPage) {
      curPage.processMessage(message);
    }
  }

  for (var i in pages) {
    var page = pages[i];
    if (page.isOk()) {
      var pageHAR = page.getHAR();
      har.log.pages.push(pageHAR.info);
      Array.prototype.push.apply(har.log.entries, pageHAR.entries);
    }
  }

  return har;
}

var Page = function (id, url, frameId) {
  this.id = id;
  this.url = url;
  this.frameId = frameId;
  this.entries = {};
  this.startTimestamp = -1;
  this.firstByteTimestamp = -1;
  this.loadEndTimestamp = -1;
  this.originalRequestId = undefined;
  this.originalRequestStatus = undefined; // true ok; false fail
}

Page.prototype.start = function () {
  this.startTimestamp = new Date();
}

Page.prototype.domLoaded = function () {
  this.domLoadedTime = new Date() - this.startTimestamp;
}

Page.prototype.end = function () {
  this.endTime = new Date() - this.startTimestamp;
}

Page.prototype.isDone = function () {
  // a page is done if both Page.domContentEventFired and Page.loadEventFired
  // events are fired and the original request got a response
  return this.domLoadedTime && this.endTime &&
      this.originalRequestId &&
      typeof this.originalRequestStatus != 'undefined';
}

Page.prototype.isOk = function () {
  return this.originalRequestStatus;
}

// typical sequence:
//
// Network.requestWillBeSent # about to send a request
// Network.responseReceived  # headers received
// Network.dataReceived      # data chunk received
// [...]
// Network.loadingFinished   # full response received
Page.prototype.processMessage = function (message) {
  var id = message.params.requestId;
  switch (message.method) {
    case 'Network.requestWillBeSent':
      if (!this.originalRequestId &&
          sameURL(this.url, message.params.request.url)) {
            this.originalRequestId = id;
          }

       // Process redirect response
      var redirectEntry = undefined;
      if (message.params.redirectResponse) {
        redirectEntry = this.entries[id];
        redirectEntry.responseEvent = {'response': message.params.redirectResponse}
        redirectEntry.responseFinished = message.params.timestamp;
      }
      this.entries[id] = {
        'requestEvent': message.params,
        'responseEvent': undefined,
        'responseLength': 0,
        'encodedResponseLength': 0,
        'responseFinished': undefined
      };
      if (redirectEntry) {
        this.entries[id]['redirectFrom'] = redirectEntry;
      }


      if (this.startTimestamp < 0 || message.params.timestamp < this.startTimestamp) {
        this.startTimestamp = message.params.timestamp;
      }

      break;
    case 'Network.dataReceived':
      if (id in this.entries) {
        this.entries[id].responseLength += message.params.dataLength;
        this.entries[id].encodedResponseLength += message.params.encodedDataLength;
      }
      //Page first byte timestamp
      if (this.firstByteTimestamp < 0 || message.params.timestamp < this.firstByteTimestamp) {
        this.firstByteTimestamp = message.params.timestamp;
      }
      break;
    case 'Network.responseReceived':
      if (id in this.entries) {
        this.entries[id].responseEvent = message.params;
      }
      //Page first byte timestamp
      if (this.firstByteTimestamp < 0 || message.params.timestamp < this.firstByteTimestamp) {
        this.firstByteTimestamp = message.params.timestamp;
      }
      break;
    case 'Network.loadingFinished':
      if (id == this.originalRequestId) {
        this.originalRequestStatus = true;
      }
      if (id in this.entries) {
        this.entries[id].responseFinished = message.params.timestamp;
      }
      //Page load finish time
      if (message.params.timestamp > this.loadEndTimestamp) {
        this.loadEndTimestamp = message.params.timestamp;
      }
      break;
    case 'Network.loadingFailed':
      if (id == this.originalRequestId) {
        this.originalRequestStatus = false;
      }
      if (id in this.entries) {
        this.entries[id].responseFinished = message.params.timestamp;
        this.entries[id].errorCode = 12999;
      }
      //Page load finish time
      if (message.params.timestamp > this.loadEndTimestamp) {
        this.loadEndTimestamp = message.params.timestamp;
      }
      break;
    case 'Page.loadEventFired':
      //Page load finish time
      if (message.params.timestamp > this.loadEndTimestamp) {
        this.loadEndTimestamp = message.params.timestamp;
      }
      break;
    default:
      break;
  }
}

Page.prototype.getHAR = function () {
  var ttfb = Math.round(1000 * (this.firstByteTimestamp - this.startTimestamp));
  var loadTime = Math.round(1000 * (this.loadEndTimestamp - this.startTimestamp));
  var har = {
    'info': {
      'startedDateTime': (new Date(this.startTimestamp * 1000)).toISOString(),
      'id': this.id.toString(),
      'title': this.url,
      'pageTimings': {
        'onContentLoad': loadTime,
        'onLoad': loadTime,
        '_loadTime': loadTime,
        '_TTFB': ttfb,
      }
    },
    'entries': []
  };

  var flatedEntries = [];
  for (var requestId in this.entries) {
    var entry = this.entries[requestId];
    flatedEntries.push(entry);
    while(entry.redirectFrom) {
      flatedEntries.push(entry.redirectFrom);
      entry = entry.redirectFrom;
    }
  }

  for (var requestId in flatedEntries) {
    var entry = flatedEntries[requestId];

    // skip incomplete entries
    if (!entry.responseEvent) {
      continue;
      entry.responseEvent = {};
      entry.responseEvent.response = {
          'status': 12999,
          'headers': {},
          'fromDiskCache': false,
          'timing': {
              'requestTime': entry.requestEvent.timestamp,
              'proxyStart': -1,
              'proxyEnd': -1,
              'dnsStart': -1,
              'dnsEnd': -1,
              'connectStart': -1,
              'connectEnd': -1,
              'sslStart': -1,
              'sslEnd': -1,
              'sendStart': -1,
              'sendEnd': -1,
              'receiveHeadersEnd': -1
          },
          'headersText': '',
          'requestHeaders': {},
      }
    }
    if (!entry.responseFinished) {
      entry.responseFinished = this.loadEndTimestamp;
    }

    // skip entries with no timing information (it's optional)    
    var timing = entry.responseEvent.response.timing;
    //var timing = entry.responseEvent.response.timing;
    if (!timing) continue;

    // skip data URI scheme requests
    if (entry.requestEvent.request.url.substr(0, 5) == 'data:') continue;

    // analyze headers
    var requestHeaders = parseHeaders(entry.requestEvent.request.headers);
    var responseHeaders = parseHeaders(entry.responseEvent.response.headers);

    // add status line length
    requestHeaders.size += (entry.requestEvent.request.method.length +
        entry.requestEvent.request.url.length +
        12); // "HTTP/1.x" + "  " + "\r\n"

    responseHeaders.size += (entry.responseEvent.response.status.toString().length +
        entry.responseEvent.response.statusText.length +
        12); // "HTTP/1.x" + "  " + "\r\n"

    // query string
    var queryString = parseQueryString(entry.requestEvent.request.url);

    // compute timing informations: input
    var dnsTime = timeDelta(timing.dnsStart, timing.dnsEnd);
    var proxyTime = timeDelta(timing.proxyStart, timing.proxyEnd);
    var connectTime = timeDelta(timing.connectStart, timing.connectEnd);
    var sslTime = timeDelta(timing.sslStart, timing.sslEnd);
    var sendTime = timeDelta(timing.sendStart, timing.sendEnd);

    // compute timing informations: output
    var dns = proxyTime + dnsTime;
    if (timing.dnsStart == -1) {
      dns = -1;
    }
    var connect = connectTime;
    if (timing.connectStart == -1) {
      connect = -1;
    }
    var ssl = sslTime;
    if (timing.sslStart == -1) {
      ssl = -1;
    }
    var send = sendTime;
    var wait = timing.receiveHeadersEnd - timing.sendEnd;
    var receive = Math.round(entry.responseFinished * 1000 -
        timing.requestTime * 1000 - timing.receiveHeadersEnd);
    var blocked = -1; // TODO
    var ttfb = send + wait;
    var totalTime = Math.max(dns, 0) + Math.max(0, connect) +
        Math.max(0, ssl) + Math.max(0, send) + Math.max(0, wait) +
        Math.max(0, receive);

    // fill entry
    har.entries.push({
        'pageref': this.id.toString(),
        'startedDateTime': new Date(timing.requestTime * 1000).toISOString(),
        'time': totalTime,
        'request': {
          'method': entry.requestEvent.request.method,
          'url': entry.requestEvent.request.url,
          'httpVersion': 'HTTP/1.1', // TODO
          'cookies': [], // TODO
          'headers': requestHeaders.pairs,
          'queryString': queryString,
          'headersSize': requestHeaders.size,
          'bodySize': entry.requestEvent.request.headers['Content-Length'] || -1,
        },
        'response': {
          'status': entry.responseEvent.response.status,
          'statusText': entry.responseEvent.response.statusText,
          'httpVersion': 'HTTP/1.1', // TODO
          'cookies': [], // TODO
          'headers': responseHeaders.pairs,
          'redirectURL': '', // TODO
          'headersSize': responseHeaders.size,
          'bodySize': entry.encodedResponseLength,
          'content': {
            'size': entry.responseLength,
            'mimeType': entry.responseEvent.response.mimeType,
            'compression': entry.responseLength - entry.encodedResponseLength
          }
        },
        'cache': {},
        'timings': {
          'blocked': blocked,
          'dns': dns,
          'connect': connect, // -1 = n.a.
          'send': send,
          'wait': wait,
          'receive': receive,
          'ssl': ssl,
        },
        '_ttfb_ms': ttfb,
        '_full_url': entry.requestEvent.request.url,
        '_host': parseHost(entry.requestEvent.request.url),
    });
  }

  // Sort entry
  har.entries.sort(function(a, b){
    if (a.startedDateTime  < b.startedDateTime)
      return -1;
    else if (a.startedDateTime  > b.startedDateTime)
      return 1;
    else return 0;
  });
  return har;
}

function parseQueryString(fullUrl) {
  var query = url.parse(fullUrl, true).query;
  var pairs = [];
  for (var name in query) {
    var value = query[name];
    pairs.push({'name': name, 'value': value.toString()});
  }
  return pairs;
}

function parseHost(fullUrl) {
  return url.parse(fullUrl, true).hostname;
}

function parseHeaders(headers) {
  headersObject = {'pairs': [], 'size': -1};
  if (Object.keys(headers).length) {
    headersObject.size = 2; // trailing "\r\n"
    for (var name in headers) {
      var value = headers[name];
      headersObject.pairs.push({'name': name, 'value': value});
      headersObject.size += name.length + value.length + 4; // ": " + "\r\n"
    }
  }
  return headersObject;
}

function timeDelta(start, end) {
  return start != -1 && end != -1 ? (end - start) : 0;
}

function sameURL(a, b) {
  return JSON.stringify(url.parse(a)) == JSON.stringify(url.parse(b));
}


