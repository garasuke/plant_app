import { File, Paths } from 'expo-file-system';

export const DEFAULT_URL = 'https://192.168.0.143:8001';

const cfgFile = () => new File(Paths.document, 'client_config.json');

export async function loadUrl(): Promise<string> {
  try {
    const f = cfgFile();
    if (f.exists) {
      const j = JSON.parse(await f.text());
      if (j && typeof j.url === 'string' && j.url.startsWith('http')) return j.url;
    }
  } catch {
    // 読めなければ既定値
  }
  return DEFAULT_URL;
}

export function saveUrl(url: string): void {
  const f = cfgFile();
  if (!f.exists) f.create();
  f.write(JSON.stringify({ url }));
}
