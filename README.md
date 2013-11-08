WebTestServer
=======

WebTestServer is used for testing web page errors and latency at sever side on unix* platform.
Derived from webpagetest nodejs agent.

Features
=======
* HTTP API to submit test and get result files, including HAR data and screen shot.
* Support WebDriverJS test script(use for click, fill forms, etc.).
* Support test proxy server and proxy pac file.
* Support multi tests at the same time.
* Support Chrome and Phantomjs(Not implemented yet) test method.

System Requirement
=======
nodejs: 0.8+
Google Chrome: 26+, ChromeDriver 2.4+.

Install Guide
=======
Make sure you have installed Google Chrome or Chromium(including flash plugin if you want test pages contain flash), Xvfb.
The agent will use Xvfb to render the webpage by default.

Run with root if you want use tcpdump feature.

Run
======
./agent.sh {start|stop|restart|status}

Check the http://localhost:8888 to see the web portal.
8888 is the default http port, you can change to other port in agent.sh.

HTTP API
======

/task/submit  GET/POST
Submit task for test.

Accept field:
  url:  web page url.
  script: test script.(url and script must exist one)

Return: JSON data, for example:
{‘id’: ‘test_id’, ‘’position’: 0}


/task/{id}/status GET
Check task status.


/task/result/{id}/filename  GET
Get task result file.

