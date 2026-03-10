import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';

const LS_KEY = 'oddity_docs';
const DEBOUNCE_MS = 1500;

function readLS() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  } catch { return {}; }
}

function writeLS(docs) {
  localStorage.setItem(LS_KEY, JSON.stringify(docs));
}

function generateId() {
  return crypto.randomUUID();
}

export function useDocuments() {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const debounceTimers = useRef({});

  // Load documents on mount
  useEffect(() => {
    loadDocuments();
    window.addEventListener('online', syncDirtyDocs);
    return () => window.removeEventListener('online', syncDirtyDocs);
  }, []);

  async function loadDocuments() {
    setLoading(true);
    const local = readLS();

    // Fetch from Supabase
    try {
      const { data, error } = await supabase
        .from('documents')
        .select('*')
        .order('updated_at', { ascending: false });

      if (!error && data) {
        // Merge: Supabase is source of truth, but keep dirty local docs
        const merged = { ...local };

        for (const doc of data) {
          if (!merged[doc.id] || !merged[doc.id].dirty) {
            merged[doc.id] = { ...doc, dirty: false };
          }
        }

        writeLS(merged);
        setDocuments(Object.values(merged).sort((a, b) =>
          new Date(b.updated_at) - new Date(a.updated_at)
        ));
      } else {
        // Offline or error — use local
        setDocuments(Object.values(local).sort((a, b) =>
          new Date(b.updated_at) - new Date(a.updated_at)
        ));
      }
    } catch {
      setDocuments(Object.values(local).sort((a, b) =>
        new Date(b.updated_at) - new Date(a.updated_at)
      ));
    }

    setLoading(false);
  }

  async function syncDirtyDocs() {
    const local = readLS();
    for (const [id, doc] of Object.entries(local)) {
      if (!doc.dirty) continue;
      try {
        const { dirty, ...rest } = doc;
        await supabase.from('documents').upsert(rest);
        local[id] = { ...rest, dirty: false };
      } catch { /* will retry on next online event */ }
    }
    writeLS(local);
  }

  const createDocument = useCallback(async (overrides = {}) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not authenticated');

    const id = generateId();
    const now = new Date().toISOString();
    const doc = {
      id,
      user_id: session.user.id,
      title: 'Untitled',
      content: null,
      plain_text: '',
      annotations: null,
      word_count: 0,
      created_at: now,
      updated_at: now,
      dirty: true,
      ...overrides,
    };

    const local = readLS();
    local[id] = doc;
    writeLS(local);
    setDocuments((prev) => [doc, ...prev]);

    // Background Supabase insert
    const { dirty, ...rest } = doc;
    supabase.from('documents').insert(rest).then(({ error }) => {
      if (!error) {
        const l = readLS();
        if (l[id]) { l[id].dirty = false; writeLS(l); }
      }
    });

    return id;
  }, []);

  const getDocument = useCallback((id) => {
    const local = readLS();
    return local[id] || null;
  }, []);

  const updateDocument = useCallback((id, partial) => {
    const local = readLS();
    if (!local[id]) return;

    const updated = {
      ...local[id],
      ...partial,
      updated_at: new Date().toISOString(),
      dirty: true,
    };
    local[id] = updated;
    writeLS(local);

    setDocuments((prev) =>
      prev.map((d) => (d.id === id ? updated : d))
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    );

    // Debounced Supabase upsert
    if (debounceTimers.current[id]) clearTimeout(debounceTimers.current[id]);
    debounceTimers.current[id] = setTimeout(async () => {
      const fresh = readLS();
      if (!fresh[id]) return;
      const { dirty, ...rest } = fresh[id];
      const { error } = await supabase.from('documents').upsert(rest);
      if (!error) {
        const l = readLS();
        if (l[id]) { l[id].dirty = false; writeLS(l); }
      }
    }, DEBOUNCE_MS);
  }, []);

  const deleteDocument = useCallback(async (id) => {
    const local = readLS();
    delete local[id];
    writeLS(local);
    setDocuments((prev) => prev.filter((d) => d.id !== id));

    await supabase.from('documents').delete().eq('id', id);
  }, []);

  return {
    documents,
    loading,
    createDocument,
    getDocument,
    updateDocument,
    deleteDocument,
    refreshDocuments: loadDocuments,
  };
}
