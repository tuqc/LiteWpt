#!/bin/bash

export ROOT_DIR=`pwd`
export OS=`uname -ms`
export WPT_MAX_LOGLEVEL="debug"

# Use the latest WebDriver javascript
#declare -a wdjs_dirs=("${wpt_root}/lib/webdriver/javascript/node-"*)
export NODE_PATH="${NODE_PATH}:${ROOT_DIR}/src"

declare -a selenium_jars=("${ROOT_DIR}/lib/selenium-standalone-"*.jar)
declare selenium_jar="${selenium_jars[@]:+${selenium_jars[${#selenium_jars[@]}-1]}}"
declare -a chromedrivers=("${ROOT_DIR}/lib/chromedriver-"*)
declare chromedriver="${chromedrivers[@]:+${chromedrivers[${#chromedrivers[@]}-1]}}"
declare browser="browser_local_chrome.BrowserLocalChrome"

export cmd_arg="--browser ${browser} --chromedriver ${chromedriver} --seleniumJar ${selenium_jar}"

echo "Run with ${cmd_arg}"

node ${ROOT_DIR}/src/agent_main.js ${cmd_arg}
