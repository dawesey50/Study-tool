import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider, createBrowserRouter, Navigate } from 'react-router-dom';
import { App } from './App';
import { ModulePage } from './pages/ModulePage';
import { ModulesPage } from './pages/ModulesPage';
import { SectionPage } from './pages/SectionPage';
import { SourcesPage } from './pages/SourcesPage';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Everything is local, so refetching is cheap and staleness is the
      // bigger risk — especially right after an ingest.
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <ModulesPage /> },
      { path: 'modules/:moduleId', element: <ModulePage /> },
      { path: 'modules/:moduleId/sources', element: <SourcesPage /> },
      { path: 'modules/:moduleId/sections/:sectionId', element: <SectionPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
