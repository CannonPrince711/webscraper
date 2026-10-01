Webscraper (portable)
=====================

Everything lives in this one folder:

  Webscraper.exe   the app - double-click to start
  _internal\       program files (replaced by updates)
  data\            YOUR data: settings (.env), generated secrets, scraped records
                   (never touched by updates)

Start it and your browser opens to the dashboard. Use the red Stop button in the
app to quit completely (closing the browser tab does not stop it).

Settings -> Variables edits data\.env (AI provider, proxy, limits). Settings ->
Updates installs new versions from GitHub Releases; turn off automatic updates
there if you prefer to update manually.

Moving or backing up: close the app, then copy this whole folder.
Uninstalling: close the app and delete this folder. Nothing is written to the
registry or anywhere else.
