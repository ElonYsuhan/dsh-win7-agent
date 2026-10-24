; NSIS 3 Unicode supports Windows 7; fail clearly on unsupported OS/architecture.
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
!macroend
