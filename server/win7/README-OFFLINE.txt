DSH-Win7-Service offline portable package
=========================================

Target platform: Windows 7 SP1 x64
Internet required: no
Node.js required: no
Model service: external, configure in the web UI

How to start
------------
1. Copy this whole folder to the Windows 7 server.
2. Double click start-service.cmd.
3. Open http://SERVER_IP:8080 from the Electron shell or a browser.
4. Configure the model Base URL in Settings.

Default data directory
----------------------
data\settings.json
data\workspace
data\sessions

Windows service
---------------
The package is a portable service process. To run it as a background
Windows service, use NSSM or another service wrapper and point it to
start-service.cmd. The wrapper must run the command in this directory.
