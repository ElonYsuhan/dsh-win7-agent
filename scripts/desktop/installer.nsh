; NSIS 3 Unicode supports Windows 7; fail clearly on unsupported OS/architecture.
; Keep this file ASCII-only: NSIS 3.0.4.1 rejects non-ASCII bytes in an
; included script without a UTF-8 BOM ("Bad text encoding").
!macro customInit
  ${IfNot} ${AtLeastWin7}
    MessageBox MB_OK|MB_ICONSTOP "Agent requires Windows 7 SP1 x64 or later."
    Quit
  ${EndIf}
  ${If} ${IsWin7}
    ${AndIfNot} ${AtLeastServicePack} 1
    MessageBox MB_OK|MB_ICONSTOP "Agent requires Windows 7 Service Pack 1."
    Quit
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Agent requires 64-bit Windows."
    Quit
  ${EndIf}
  ; Same immutable payload already installed: start the installed application
  ; and end the installer. Quitting inside .onInit creates no window, so a
  ; second double-click on the distribution file behaves like the app itself
  ; instead of showing the install progress UI again.
  !ifdef AGENT_PACKAGE_BUILD_ID
    ReadRegStr $R0 HKCU "Software\Agent\OfflineLauncher" "BuildId"
    ReadRegStr $R1 HKCU "Software\Agent\OfflineLauncher" "InstallDir"
    ${If} $R0 == "${AGENT_PACKAGE_BUILD_ID}"
    ${AndIf} $R1 != ""
      IfFileExists "$R1\${APP_EXECUTABLE_FILENAME}" 0 agent_launcher_stale
      ClearErrors
      Exec '"$R1\${APP_EXECUTABLE_FILENAME}"'
      ${IfNot} ${Errors}
        Quit
      ${EndIf}
      agent_launcher_stale:
    ${EndIf}
  !endif
!macroend

!macro customInstall
  !ifdef AGENT_PACKAGE_BUILD_ID
    WriteRegStr HKCU "Software\Agent\OfflineLauncher" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "Software\Agent\OfflineLauncher" "BuildId" "${AGENT_PACKAGE_BUILD_ID}"
  !endif
  ; The desktop entry must point at the installed application. The distribution
  ; file is an installer and re-extracts on every launch. electron-builder skips
  ; desktop shortcut creation on the update path, so create it explicitly.
  CreateShortCut "$DESKTOP\Agent.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ; The shell caches desktop icons by shortcut path and does not always notice
  ; that the target exe carries a new icon after an in-place upgrade, so users
  ; keep seeing the old (smaller) bitmap and report "installing does not update
  ; the icon". Drop the cache at the end of every install. SHChangeNotify is the
  ; portable part (works on Win7); ie4uinit only ships from Win8 on.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  ${IfNot} ${IsWin7}
    ExecWait '"$SYSDIR\ie4uinit.exe" -ClearIconCache'
  ${EndIf}
  ClearErrors
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Agent\OfflineLauncher"
!macroend
