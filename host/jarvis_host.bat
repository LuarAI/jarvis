@echo off
rem Chrome launches this as the native messaging host. @echo off is MANDATORY:
rem anything echoed lands on stdout and corrupts the length-prefixed JSON framing.
rem
rem python (not pythonw): the protocol IS stdio, and pythonw detaches from the
rem standard handles on some launch paths, which silently breaks the pipe. Chrome
rem starts hosts with a hidden window anyway, so there is no console flash.
rem -u = unbuffered, required on Windows for this protocol.
python -u "%~dp0jarvis_host.py" %*
