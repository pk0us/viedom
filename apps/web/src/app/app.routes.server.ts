import { RenderMode } from '@angular/ssr';
import type { ServerRoute } from '@angular/ssr';

export const serverRoutes: ServerRoute[] = [
  {
    path: '',
    renderMode: RenderMode.Server
  },
  { path: 'health', renderMode: RenderMode.Server },
  { path: '**', renderMode: RenderMode.Client }
];
