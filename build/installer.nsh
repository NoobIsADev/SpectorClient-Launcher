!macro customInit
  ; A stale SpectorClient process can keep app.asar / DLLs / the EXE locked and
  ; cause "Failed to uninstall old application files". The update/manual
  ; installer is a differently named process, so this only targets the installed
  ; launcher executable. taskkill is synchronous; the short wait gives Windows
  ; time to release file handles before electron-builder's uninstall step begins.
  nsExec::ExecToStack '"$SYSDIR\\taskkill.exe" /F /T /IM "SpectorClient.exe"'
  Pop $0
  Pop $1
  Sleep 1200
!macroend
