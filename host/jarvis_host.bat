@echo off
rem Chrome launches this as the native messaging host. @echo off is MANDATORY:
rem anything echoed lands on stdout and corrupts the length-prefixed JSON framing.
rem -u keeps Python unbuffered (required on Windows for this protocol); pythonw
rem avoids a console flash. install.cmd bakes the interpreter choice in below.
pythonw -u "%~dp0jarvis_host.py" %*
