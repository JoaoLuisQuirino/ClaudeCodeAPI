import { IncomingMessage, ServerResponse } from 'node:http';

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const patternStr = path.replace(/:([^/]+)/g, (_, name: string) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    this.routes.push({
      method: method.toUpperCase(),
      pattern: new RegExp(`^${patternStr}$`),
      paramNames,
      handler,
    });
  }

  get(path: string, handler: RouteHandler): void { this.add('GET', path, handler); }
  post(path: string, handler: RouteHandler): void { this.add('POST', path, handler); }
  delete(path: string, handler: RouteHandler): void { this.add('DELETE', path, handler); }

  match(method: string, url: string): { handler: RouteHandler; params: Record<string, string> } | null {
    const path = url.split('?')[0];
    const upperMethod = method.toUpperCase();
    for (const route of this.routes) {
      if (route.method !== upperMethod) continue;
      const m = path.match(route.pattern);
      if (!m) continue;
      const params: Record<string, string> = {};
      for (let i = 0; i < route.paramNames.length; i++) {
        params[route.paramNames[i]] = decodeURIComponent(m[i + 1]);
      }
      return { handler: route.handler, params };
    }
    return null;
  }
}
