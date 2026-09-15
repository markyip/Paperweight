; Register as an Open-with / Default apps candidate without stealing
; Explorer's .pdf / .epub default (that would hide system thumbnails).
; Tauri's APP_ASSOCIATE still creates the ProgIDs; we snapshot the previous
; extension default in NSIS_HOOK_PREINSTALL (before Tauri overwrites it)
; and restore it in NSIS_HOOK_POSTINSTALL.

!macro BackupExtDefault EXT FILECLASS
  ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" ""
  WriteRegStr SHCTX "Software\Classes\.${EXT}" "${FILECLASS}_backup" "$R0"
!macroend

!macro RestoreExtDefault EXT FILECLASS
  ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" "${FILECLASS}_backup"
  StrCmp $R0 "" restore_empty_${EXT} restore_prev_${EXT}
  restore_empty_${EXT}:
    DeleteRegValue SHCTX "Software\Classes\.${EXT}" ""
    Goto restore_done_${EXT}
  restore_prev_${EXT}:
    WriteRegStr SHCTX "Software\Classes\.${EXT}" "" "$R0"
  restore_done_${EXT}:
    DeleteRegValue SHCTX "Software\Classes\.${EXT}" "${FILECLASS}_backup"
    WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${FILECLASS}" ""
!macroend

!macro RemoveLegacyPageviewer
  DeleteRegKey SHCTX "Software\Classes\Pageviewer.PDF"
  DeleteRegKey SHCTX "Software\Classes\Pageviewer.EPUB"
  DeleteRegKey SHCTX "Software\Classes\Applications\Pageviewer.exe"
  DeleteRegValue SHCTX "Software\Classes\.pdf\OpenWithProgids" "Pageviewer.PDF"
  DeleteRegValue SHCTX "Software\Classes\.epub\OpenWithProgids" "Pageviewer.EPUB"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Pageviewer"
  DeleteRegKey SHCTX "Software\Pageviewer"
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; Capture the extension's current default ProgID before Tauri's own
  ; file-association step overwrites it further down in the install.
  !insertmacro BackupExtDefault "pdf" "Paperweight.PDF"
  !insertmacro BackupExtDefault "epub" "Paperweight.EPUB"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro RemoveLegacyPageviewer
  !insertmacro RestoreExtDefault "pdf" "Paperweight.PDF"
  !insertmacro RestoreExtDefault "epub" "Paperweight.EPUB"

  WriteRegStr SHCTX "Software\Paperweight\Capabilities" "ApplicationName" "Paperweight"
  WriteRegStr SHCTX "Software\Paperweight\Capabilities" "ApplicationDescription" "Lightweight PDF / EPUB reader"
  WriteRegStr SHCTX "Software\Paperweight\Capabilities\FileAssociations" ".pdf" "Paperweight.PDF"
  WriteRegStr SHCTX "Software\Paperweight\Capabilities\FileAssociations" ".epub" "Paperweight.EPUB"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Paperweight" "Software\Paperweight\Capabilities"

  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue SHCTX "Software\Classes\.pdf\OpenWithProgids" "Paperweight.PDF"
  DeleteRegValue SHCTX "Software\Classes\.epub\OpenWithProgids" "Paperweight.EPUB"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Paperweight"
  DeleteRegKey SHCTX "Software\Paperweight"
  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
!macroend
