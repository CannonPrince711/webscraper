; Portable "installer": unpacks the app into ONE folder you choose, with no
; registry entries, no uninstaller and no start-menu clutter. Delete the folder
; to remove it.
#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\dist\release"
#endif

[Setup]
AppId={{8F1F7C52-3B7E-4B8E-9C0B-2F6C1A51D3A4}
AppName=Webscraper
AppVersion={#Version}
AppPublisher=Webscraper
DefaultDirName={userdocs}\Webscraper
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
Uninstallable=no
CreateUninstallRegKey=no
OutputDir=..\..\dist
OutputBaseFilename=Webscraper-Setup
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible

[Dirs]
Name: "{app}\data"; Permissions: users-modify

[Files]
Source: "{#SourceDir}\Webscraper\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion createallsubdirs

[Run]
Filename: "{app}\Webscraper.exe"; Description: "Start Webscraper now"; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent
