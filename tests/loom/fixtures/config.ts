export interface Config {
  page: unknown;
}

export type Mode = 'fast' | 'slow';

export default class Store {
  read(): Config | null {
    return null;
  }
}
