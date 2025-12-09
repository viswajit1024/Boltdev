import { WebContainer } from '@webcontainer/api';
import { useEffect, useState, useRef } from 'react';

interface PreviewFrameProps {
  files: any[];
  webContainer?: WebContainer;
  retryKey?: number;
  onStatusChange?: (status: 'idle' | 'installing' | 'running' | 'ready' | 'error') => void;
  onRetry?: () => void;
  onLog?: (s: string) => void;
}

export function PreviewFrame({ files, webContainer, retryKey, onStatusChange, onRetry, onLog }: PreviewFrameProps) {
  const [url, setUrl] = useState('');
  const [status, setStatus] = useState<'idle' | 'installing' | 'running' | 'ready' | 'error'>('idle');
  const processRefs = useRef<any>({ install: null, run: null, serverReadyListener: null });

    function updateStatus(s: 'idle' | 'installing' | 'running' | 'ready' | 'error') {
    setStatus(s);
    if (onStatusChange) onStatusChange(s);
  }
  function log(s: string) { console.log(s); if (onLog) onLog(s); }

  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function main() {
    if (!webContainer) return;
    // Basic check: ensure package.json exists in `files`
    function findPackage(farr: any[]): boolean {
      for (const f of farr) {
        if (f.type === 'file' && f.name === 'package.json') return true;
        if (f.type === 'folder' && f.children && findPackage(f.children)) return true;
      }
      return false;
    }
    if (!findPackage(files)) {
      setErrorMessage('package.json not found: preview cannot run without a package.json at root.');
      updateStatus('error');
      return;
    }

    // Determine which script to run: prefer `dev`, fallback to `start`
    function findPackageContent(farr: any[]): string | undefined {
      for (const f of farr) {
        if (f.type === 'file' && f.name === 'package.json') return f.content;
        if (f.type === 'folder' && f.children) {
          const c = findPackageContent(f.children);
          if (c) return c;
        }
      }
      return undefined;
    }
    const pkgContent = findPackageContent(files) || '{}';
    let runScript = 'dev';
    try {
      const parsed = JSON.parse(pkgContent);
      if (parsed.scripts && parsed.scripts.dev) runScript = 'dev';
      else if (parsed.scripts && parsed.scripts.start) runScript = 'start';
      else {
        setErrorMessage('package.json missing a `dev` or `start` script; preview cannot start.');
        updateStatus('error');
        return;
      }
    } catch (e) {
      setErrorMessage('Invalid package.json JSON: ' + String(e));
      updateStatus('error');
      return;
    }
    log('PreviewFrame: starting main; files: ' + (files?.map((f: any) => f.path || f.name).join(', ') ?? 'none'));
    try {
      updateStatus('installing');
      const installProcess = await webContainer.spawn('npm', ['install']);
      processRefs.current.install = installProcess;

      // pipe install logs to the console for debug
      try {
        installProcess.output.pipeTo(new WritableStream({
          write(data) {
            console.log(data);
          }
        }));
      } catch (e) {
        // not critical
      }

      updateStatus('running');
      log(`PreviewFrame: running npm run ${runScript}`);
      const runProcess = await webContainer.spawn('npm', ['run', runScript]);
      processRefs.current.run = runProcess;

      const listener = (port: number, url: string) => {
        log('server-ready -> ' + url);
        log('port -> ' + port);
        setUrl(url);
        updateStatus('ready');
      };
      processRefs.current.serverReadyListener = listener;
      try {
        if (!processRefs.current.serverReadyListenerAdded) {
          webContainer.on('server-ready', listener);
          processRefs.current.serverReadyListenerAdded = true;
        }
      } catch (e) {
        // swallow
      }
    } catch (err) {
      log('PreviewFrame failed to start: ' + String(err));
      setErrorMessage(String(err));
      updateStatus('error');
    }
  }

  useEffect(() => {
    if (!webContainer) return;
    if (!files || files.length === 0) {
      updateStatus('idle');
      return;
    }
    main();
    return () => {
      try {
        // No reliable public API for removing server-ready listeners across all WebContainer versions.
        // For safety, only indicate we're no longer managing a listener so subsequent mounts can re-add if needed.
        if (processRefs.current) {
          processRefs.current.serverReadyListenerAdded = false;
        }
      } catch (e) {
        /* ignore */
      }
    };
  }, [webContainer, files, retryKey]);

  return (
    <div className="h-full flex items-center justify-center text-gray-400 flex-col">
      {!url && (
        <div className="text-center mb-4">
          <p className="mb-2">
            {status === 'idle'
              ? 'Preview not yet available'
              : status === 'installing'
              ? 'Installing dependencies (this may take a while)...'
              : status === 'running'
              ? 'Starting server...'
              : status === 'error'
              ? 'Failed to start preview'
              : 'Preparing preview...'}
          </p>
          {(status === 'error' || status === 'idle') && (
            <button
              className="bg-red-400 px-3 py-1 rounded"
              onClick={() => {
                updateStatus('idle');
                setUrl('');
                if (onRetry) onRetry();
              }}
            >
              Retry
            </button>
          )}
          {status === 'error' && errorMessage && <div className='text-red-300 text-xs mt-2'>{errorMessage}</div>}
        </div>
      )}
      {url && <iframe width={"100%"} height={"100%"} src={url} title="Preview" />}
        </div>
      );
    }