'use strict'

;(function () {
  const not = (value) => value ? false : true
  const DB_NAME = 'dsh-agent-db'
  const STORE_NAME = 'kv'
  let dbPromise = null

  function openDb() {
    if (not(window.indexedDB)) return Promise.reject(new Error('NO_INDEXEDDB'))
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        if (not(db.objectStoreNames.contains(STORE_NAME))) db.createObjectStore(STORE_NAME)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return dbPromise
  }

  function withStore(mode, action) {
    return openDb().then((db) => {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode)
        const store = transaction.objectStore(STORE_NAME)
        const request = action(store)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
        transaction.onerror = () => reject(transaction.error)
      })
    })
  }

  window.sessionDb = {
    load: () => withStore('readonly', (store) => store.get('sessions')),
    save: (value) => withStore('readwrite', (store) => store.put(value, 'sessions'))
  }
})()
