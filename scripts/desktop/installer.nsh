; NSIS 3 Unicode supports Windows 7; fail clearly on unsupported OS/architecture.
; Keep this file ASCII-only: NSIS 3.0.4.1 rejects non-ASCII bytes in an
; included script without a UTF-8 BOM ("Bad text encoding").
!macro agentInstallTrace TEXT
  Push $R8
  FileOpen $R8 "$TEMP\Agent-install-trace.txt" a
  FileWrite $R8 "${TEXT}; exe=$EXEPATH; target=$INSTDIR$\r$\n"
  FileClose $R8
  Pop $R8
!macroend

!macro preInit
  !ifndef BUILD_UNINSTALLER
  !insertmacro agentInstallTrace "preInit"
  ; Stage under a distinct image name before acquiring the installer mutex.
  ; Legacy uninstallers must never mistake setup for the installed Agent.exe.
  !ifndef AGENT_REPAIR_INSTALL
  ${If} $EXEFILE == "Agent.exe"
    GetTempFileName $R0
    Delete "$R0"
    CreateDirectory "$R0"
    ClearErrors
    CopyFiles /SILENT "$EXEPATH" "$R0\Agent-Setup.exe"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "Unable to stage Agent setup."
      SetErrorLevel 1
      Quit
    ${EndIf}
    ${GetParameters} $R1
    ClearErrors
    Exec '"$R0\Agent-Setup.exe" $R1'
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "Unable to start Agent setup."
      SetErrorLevel 1
    ${EndIf}
    Quit
  ${EndIf}
  !endif
  Sleep 1000
  !endif
!macroend

!macro customInit
  !insertmacro agentInstallTrace "customInit"
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
  ; 覆盖安装/升级前强制结束正在运行的 Agent；安装器已在 preInit 改名为 Agent-Setup.exe，
  ; 因此这里按 Agent.exe 结束旧进程不会误杀安装器自身。修复安装（更新接管）不走这一步。
  !ifndef BUILD_UNINSTALLER
  !ifndef AGENT_REPAIR_INSTALL
    nsExec::Exec 'taskkill /F /IM Agent.exe /T'
    Pop $0
  !endif
  !endif
  ; Always show the directory-selection flow, including for the same build.
  ; The user may be repairing or relocating their installation.
!macroend

!macro customInstallMode
  ; 只保留「选择目录 → 安装」：固定按当前用户安装，跳过安装范围页，
  ; 也不触发内部提权请求（之前那个要求输入管理员密码的窗口就是它弹的）。
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  !insertmacro agentInstallTrace "customInstall"
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 agent_install_missing
  IfFileExists "$INSTDIR\Uninstall Agent.exe" 0 agent_install_missing
  IfFileExists "$INSTDIR\resources\app\desktop-build.json" 0 agent_install_missing
  Goto agent_install_files_present
  agent_install_missing:
    MessageBox MB_OK|MB_ICONSTOP "Installation did not complete.$\r$\nTarget: $INSTDIR$\r$\nChoose a folder this user can write to, or run setup as administrator."
    SetErrorLevel 2
    Quit
  agent_install_files_present:
  !ifdef AGENT_PACKAGE_BUILD_ID
    WriteRegStr HKCU "Software\Agent\OfflineLauncher" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "Software\Agent\OfflineLauncher" "BuildId" "${AGENT_PACKAGE_BUILD_ID}"
    ReadRegStr $R0 HKCU "Software\Agent\OfflineLauncher" "BuildId"
    ${If} $R0 != "${AGENT_PACKAGE_BUILD_ID}"
      MessageBox MB_OK|MB_ICONSTOP "Unable to register this installation. Run setup with administrator permissions."
      SetErrorLevel 2
      Quit
    ${EndIf}
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

!macro customCheckAppRunning
  !insertmacro agentInstallTrace "checkAppRunning"
  ; Native full-path matching. No tasklist parsing and no process termination.
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $R9
  ReadRegStr $R9 HKCU "Software\Agent\OfflineLauncher" "InstallDir"
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p.r0'
  StrCmp $0 -1 agent_process_scan_error
  System::Alloc 556
  Pop $1
  System::Call '*$1(i 556)'
  System::Call 'kernel32::Process32FirstW(p r0, p r1) i.r2'
  agent_process_next:
  StrCmp $2 0 agent_process_done
  System::Call '*$1(i, i, i.r3, i, i, i, i, i, i, &w260.r8)'
  StrCmp $8 "Agent.exe" 0 agent_process_continue
  System::Call 'kernel32::OpenProcess(i 0x1000, i 0, i r3) p.r4'
  StrCmp $4 0 agent_process_continue
  StrCpy $6 1024
  System::Call 'kernel32::QueryFullProcessImageNameW(p r4, i 0, w.r5, *i r6) i.r7'
  System::Call 'kernel32::CloseHandle(p r4)'
  StrCmp $7 0 agent_process_continue
  StrCmp $5 "$INSTDIR\Agent.exe" agent_process_found
  StrCmp $R9 "" agent_process_continue
  StrCmp $5 "$R9\Agent.exe" 0 agent_process_continue
  agent_process_found:
  System::Free $1
  System::Call 'kernel32::CloseHandle(p r0)'
  MessageBox MB_OK|MB_ICONEXCLAMATION "Please close the installed Agent application before continuing."
  SetErrorLevel 2
  Quit
  agent_process_continue:
  System::Call 'kernel32::Process32NextW(p r0, p r1) i.r2'
  Goto agent_process_next
  agent_process_done:
  System::Free $1
  System::Call 'kernel32::CloseHandle(p r0)'
  Goto agent_process_restore
  agent_process_scan_error:
  MessageBox MB_OK|MB_ICONSTOP "Unable to inspect running processes."
  SetErrorLevel 2
  Quit
  agent_process_restore:
  Pop $R9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Agent\OfflineLauncher"
!macroend
