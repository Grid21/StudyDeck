; StudyDeck installer extras. Asks at uninstall whether to delete your data. The default answer is NO.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your StudyDeck data (decks, notes, friends, settings)?$\r$\n$\r$\nChoose No to keep it for a reinstall. Deleting cannot be undone." IDNO studydeck_keep_data
      RMDir /r "$APPDATA\studydeck"
    studydeck_keep_data:
  ${endIf}
!macroend
