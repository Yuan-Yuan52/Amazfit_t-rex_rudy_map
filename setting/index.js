// =============================================================
//  手機端「App 設定頁」(在 Zepp App 裡開)
//  使用者在這裡貼上自己的 GPX 航跡下載網址 → 存進 settingsStorage
//  手錶按「匯入手機設定的網址」時，side service 會讀這個值去抓。
// =============================================================
AppSettingsPage({
  build(props) {
    const s = props.settingsStorage;
    const url = s.getItem('gpxUrl') || '';
    const name = s.getItem('gpxName') || '';

    return Section({}, [
      View({ style: { marginTop: '24px', textAlign: 'center', fontSize: '20px', fontWeight: 'bold' } },
        [Text({}, ['Rudy map · 航跡來源'])]),

      View({ style: { marginTop: '8px', marginLeft: '16px', marginRight: '16px', textAlign: 'center', color: '#888', fontSize: '13px' } },
        [Text({}, ['填一條 GPX 航跡的名稱與下載網址（Google Drive / Dropbox 分享連結、或直接 .gpx 連結都可以）'])]),

      View({ style: { marginTop: '16px', marginLeft: '16px', marginRight: '16px' } }, [
        TextInput({
          label: '軌跡名稱',
          value: name,
          placeholder: '例如：金面山',
          onChange: (v) => { s.setItem('gpxName', v); },
        }),
      ]),

      View({ style: { marginTop: '12px', marginLeft: '16px', marginRight: '16px' } }, [
        TextInput({
          label: 'GPX 網址',
          value: url,
          placeholder: '貼上分享連結…',
          onChange: (v) => { s.setItem('gpxUrl', v); },
        }),
      ]),

      View({ style: { marginTop: '24px', marginLeft: '16px', marginRight: '16px', textAlign: 'center', color: '#888', fontSize: '13px' } },
        [Text({}, ['填好後，到手錶：設定 → 管理已下載航跡 →「匯入手機設定的網址」'])]),
    ]);
  },
});
