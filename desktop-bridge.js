// AVB Player on a computer: "AVB Music Player.exe" serves this page at localhost:47812 and does for it
// what the phone app's Android side does (launcher\Desktop.cs) - the computer's songs in All music,
// saving, deleting (to the Recycle Bin), renaming, showing a file in its folder.  This gives it the
// same functions as the phone (window.AVBAndroid), so app.js runs the same on both.  Anywhere else
// (the phone, the web page) it does nothing.
(function () {
  if (!(["localhost", "127.0.0.1"].includes(location.hostname) && location.port === "47812")) return;
  // the phone answers at once, so these do too (a short synchronous request to the program next door)
  const call = (name, ...args) => {
    const x = new XMLHttpRequest();
    x.open("POST", "/__bridge/" + name, false);
    x.setRequestHeader("Content-Type", "application/json");
    x.send(JSON.stringify(args));
    if (x.status !== 200) throw new Error(name + " failed");
    return JSON.parse(x.responseText).r;
  };
  const later = f => setTimeout(f, 0);
  const none = () => { };
  window.AVBAndroid = {
    platform: () => "desktop",
    // the songs
    listMusic: () => call("listMusic"),
    listRecordings: () => call("listRecordings"),
    albumArt: () => "",
    takePending: () => "[]",
    // saving: copies and cuts to Downloads, recordings to Music\AVB Player Recordings
    saveBegin: (name, mime, where) => call("saveBegin", name, mime, where || "downloads"),
    saveChunk: (id, b64) => call("saveChunk", id, b64),
    saveEnd: id => call("saveEnd", id),
    // delete (to the Recycle Bin) and rename: the answers come back the way the phone sends them
    deletePhone: (ids, token) => later(() => { let ok = false; try { ok = !!call("deleteFiles", ids); } catch (_) { } window.avbDeleted && window.avbDeleted(token, ok); }),
    renamePhone: (id, name, token) => later(() => { let r = ""; try { r = call("rename", id, name) || ""; } catch (_) { } window.avbRenamed && window.avbRenamed(token, r); }),
    canManageMedia: () => true,          // a computer asks nothing more than the app's own question
    askManageMedia: () => true,
    // share = show the file in File Explorer
    shareMedia: id => call("reveal", id),
    shareMediaMany: ids => call("reveal", ids),
    shareBegin: (name, mime) => call("saveBegin", name, mime, "downloads"),
    shareEnd: id => call("saveEnd", id, true),
    shareApp: link => { try { navigator.clipboard.writeText(link); } catch (_) { } },
    // Settings
    addToHome: () => !!call("addToHome"),
    askDefault: () => call("askDefault"),
    version: () => call("version"),
    versionCode: () => call("versionCode"),
    updatedAgo: () => -1,
    // the computer's copy updates with its folder: the newest version is always the one running
    updateCheck: () => later(() => window.avbUpdateInfo && window.avbUpdateInfo(JSON.stringify({ code: window.AVBAndroid.versionCode(), name: window.AVBAndroid.version(), url: "" }))),
    updateInstall: () => "bad",
    openInstallSettings: none,
    // playing: the computer's media keys go through the browser's own media session
    mediaFocus: () => true, mediaState: none, mediaArt: none, playing: none, inCall: () => false,
  };
})();
