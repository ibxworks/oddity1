import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import AuthForm from "./components/AuthForm";
import Layout from "./components/Layout";
import { supabase } from "./lib/supabase";
import AccountPage from "./pages/AccountPage";
import ArchivePage from "./pages/ArchivePage";
import DocumentsPage from "./pages/DocumentsPage";
import EditorPage from "./pages/EditorPage";
import { clearAuthCookie, setAuthCookie } from "./utils/authCookie";

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setAuthCookie();
      else clearAuthCookie();
      setSession(session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) setAuthCookie();
      else clearAuthCookie();
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) return null;

  if (!session) return <AuthForm />;

  return (
    <Routes>
      <Route path="/documents/:id" element={<EditorPage session={session} />} />
      <Route element={<Layout session={session} />}>
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/settings" element={<AccountPage />} />
        <Route path="/archive" element={<ArchivePage />} />
        <Route path="/" element={<Navigate to="/archive" replace />} />
        <Route path="*" element={<Navigate to="/archive" replace />} />
      </Route>
    </Routes>
  );
}
