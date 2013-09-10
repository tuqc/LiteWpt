LiteWpt
=======

Lite version of WebPageTest for unix* platform.
Derived from webpagetest nodejs agent.

System Requirement
=======
nodejs: 0.8+
Google Chrome: 26 ~ 28, ChromeDriver need update for 29+.

Install Guide
=======
Make sure you have installed Google Chrome(including flash plugin if you want test pages contain flash), Xvfb.
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

