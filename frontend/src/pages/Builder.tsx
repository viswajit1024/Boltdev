import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { StepsList } from '../components/StepsList';
import { FileExplorer } from '../components/FileExplorer';
import { TabView } from '../components/TabView';
import { CodeEditor } from '../components/CodeEditor';
import { PreviewFrame } from '../components/PreviewFrame';
import { Step, FileItem, StepType } from '../types';
import axios from 'axios';
import { DownloadCloud, RefreshCw } from 'lucide-react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { BACKEND_URL } from '../config';
import { parseXml } from '../steps';
import { useWebContainer } from '../hooks/useWebContainer';
// Removed FileNode import - not used
import { Loader } from '../components/Loader';

// Removed MOCK_FILE_CONTENT - not used

export function Builder() {
  const location = useLocation();
  const { prompt } = location.state as { prompt: string };
  const [userPrompt, setPrompt] = useState("");
  const [llmMessages, setLlmMessages] = useState<{role: "user" | "assistant", content: string;}[]>([]);
  const [loading, setLoading] = useState(false);
  const [templateSet, setTemplateSet] = useState(false);
  const webcontainer = useWebContainer();

  const [currentStep, setCurrentStep] = useState(1);
  const [activeTab, setActiveTab] = useState<'code' | 'preview'>('code');
  const [selectedFile, setSelectedFile] = useState<FileItem | null>(null);
  
  const [steps, setSteps] = useState<Step[]>([]);

  const [files, setFiles] = useState<FileItem[]>([]);
  const [previewStatus, setPreviewStatus] = useState<'idle'|'installing'|'running'|'ready'|'error'>('idle');
  const [previewRetryKey, setPreviewRetryKey] = useState<number>(0);
  const [consoleLogs, setConsoleLogs] = useState<string[]>([]);
  const [hasPackageJson, setHasPackageJson] = useState<boolean>(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);

  useEffect(() => {
    if (previewStatus === 'ready') {
      setActiveTab('preview');
    }
  }, [previewStatus]);

  useEffect(() => {
    function searchPackage(files: FileItem[]): boolean {
      for (const f of files) {
        if (f.type === 'file' && f.name === 'package.json') return true;
        if (f.type === 'folder' && f.children) {
          if (searchPackage(f.children)) return true;
        }
      }
      return false;
    }
    setHasPackageJson(searchPackage(files));
    // reset console logs when files change
    setConsoleLogs([]);
  }, [files]);

  function flattenFilesForZip(filesArr: FileItem[], basePath = ''): {path:string, content:string}[] {
    const out: {path:string, content:string}[] = [];
    filesArr.forEach(f => {
      const path = basePath ? `${basePath}/${f.name}` : f.name;
      if (f.type === 'file') {
        out.push({path, content: f.content || ''});
      } else if (f.type === 'folder') {
        out.push(...flattenFilesForZip(f.children || [], path));
      }
    });
    return out;
  }

  async function downloadZip() {
    try {
      const zip = new JSZip();
      const flat = flattenFilesForZip(files);
      if (!flat.length) {
        alert('No files to download');
        return;
      }
      flat.forEach(file => zip.file(file.path.replace(/^\//, ''), file.content));
      const blob = await zip.generateAsync({ type: 'blob' });
      saveAs(blob, 'project.zip');
    } catch (err) {
      console.error('Failed to generate zip', err);
    }
  }
  function onPreviewLog(log: string) {
    setConsoleLogs(cs => [...cs, String(log)]);
  }

  function createDefaultPackageJson() {
    const defaultPkg = {
      name: 'generated-app',
      version: '0.0.1',
      private: true,
      scripts: {
        dev: 'vite',
        start: 'vite'
      },
    }
    const pkgFile: FileItem = {
      name: 'package.json',
      path: '/package.json',
      type: 'file',
      content: JSON.stringify(defaultPkg, null, 2)
    }
    setFiles(f => [...f, pkgFile]);
  }

  useEffect(() => {
    let originalFiles = [...files];
    let updateHappened = false;
    steps.filter(({status}) => status === "pending").map(step => {
      updateHappened = true;
      if (step?.type === StepType.CreateFile) {
        let parsedPath = step.path?.split("/") ?? []; // ["src", "components", "App.tsx"]
        let currentFileStructure = [...originalFiles]; // {}
        let finalAnswerRef = currentFileStructure;
  
        let currentFolder = ""
        while(parsedPath.length) {
          currentFolder =  `${currentFolder}/${parsedPath[0]}`;
          let currentFolderName = parsedPath[0];
          parsedPath = parsedPath.slice(1);
  
          if (!parsedPath.length) {
            // final file
            let file = currentFileStructure.find(x => x.path === currentFolder)
            if (!file) {
              currentFileStructure.push({
                name: currentFolderName,
                type: 'file',
                path: currentFolder,
                content: step.code
              })
            } else {
              file.content = step.code;
            }
          } else {
            /// in a folder
            let folder = currentFileStructure.find(x => x.path === currentFolder)
            if (!folder) {
              // create the folder
              currentFileStructure.push({
                name: currentFolderName,
                type: 'folder',
                path: currentFolder,
                children: []
              })
            }
  
            currentFileStructure = currentFileStructure.find(x => x.path === currentFolder)!.children!;
          }
        }
        originalFiles = finalAnswerRef;
      }

    })

    if (updateHappened) {

      setFiles(originalFiles)
      setSteps(steps => steps.map((s: Step) => {
        return {
          ...s,
          status: "completed"
        }
        
      }))
    }
    console.log(files);
  }, [steps, files]);

  useEffect(() => {
    const createMountStructure = (files: FileItem[]): Record<string, any> => {
      const mountStructure: Record<string, any> = {};
  
      const processFile = (file: FileItem, isRootFolder: boolean) => {  
        if (file.type === 'folder') {
          // For folders, create a directory entry
          mountStructure[file.name] = {
            directory: file.children ? 
              Object.fromEntries(
                file.children.map(child => [child.name, processFile(child, false)])
              ) 
              : {}
          };
        } else if (file.type === 'file') {
          if (isRootFolder) {
            mountStructure[file.name] = {
              file: {
                contents: file.content || ''
              }
            };
          } else {
            // For files, create a file entry with contents
            return {
              file: {
                contents: file.content || ''
              }
            };
          }
        }
  
        return mountStructure[file.name];
      };
  
      // Process each top-level file/folder
      files.forEach(file => processFile(file, true));
  
      return mountStructure;
    };
  
    const mountStructure = createMountStructure(files);
  
    // Mount the structure if WebContainer is available
    console.log('mountStructure ->', mountStructure);
    if (webcontainer) {
      webcontainer.mount(mountStructure);
      console.log('mounted to webcontainer: ', webcontainer);
    } else {
      console.log('webcontainer not ready yet, skipping mount.');
    }
  }, [files, webcontainer]);

  async function init() {
    let response;
    try {
      response = await axios.post(`${BACKEND_URL}/template`, {
        prompt: prompt.trim()
      });
      console.log('template response', response?.data);
    } catch (err: any) {
      console.error('Failed to load template:', err);
      setTemplateError(String(err));
      return;
    }
    const {prompts, uiPrompts} = response.data || {};
    if (!prompts || !uiPrompts) {
      console.error('Template response missing prompts/uiPrompts', response.data);
      // Keep templateSet false so UI shows loader and user can retry
      return;
    }

    setTemplateSet(true);

    setSteps(parseXml(uiPrompts[0]).map((x: Step) => ({
      ...x,
      status: "pending"
    })));

    setLoading(true);
    let stepsResponse;
    try {
      console.log('chat messages', [...prompts, prompt]);
      stepsResponse = await axios.post(`${BACKEND_URL}/chat`, {
        messages: [...prompts, prompt].map(content => ({
          role: "user",
          content
        }))
      })
      console.log('chat response', stepsResponse?.data);
    } catch (err: any) {
      console.error('Chat request failed', err);
      setChatError(String(err));
      setLoading(false);
      return;
    } finally {
      setLoading(false);
    }

    setSteps(s => [...s, ...parseXml(stepsResponse.data.response).map(x => ({
      ...x,
      status: "pending" as "pending"
    }))]);

    setLlmMessages([...prompts, prompt].map(content => ({
      role: "user",
      content
    })));

    setLlmMessages(x => [...x, {role: "assistant", content: stepsResponse.data.response}])
  }

  useEffect(() => {
    init();
  }, [])

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <header className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-100">Website Builder</h1>
        <p className="text-sm text-gray-400 mt-1">Prompt: {prompt}</p>
      </header>
      
      <div className="flex-1 overflow-hidden">
        <div className="h-full grid grid-cols-4 gap-6 p-6">
          <div className="col-span-1 space-y-6 overflow-auto">
            <div>
              <div className="max-h-[75vh] overflow-scroll">
                <StepsList
                  steps={steps}
                  currentStep={currentStep}
                  onStepClick={setCurrentStep}
                />
              </div>
              <div>
                <div className='flex'>
                  <br />
                  {(loading || !templateSet) && <Loader />}
                  {(!templateSet && !loading) && <div className='flex items-center gap-2'>
                    <button onClick={() => init()} className='ml-2 bg-yellow-600 px-2 py-1 rounded'>Retry Template</button>
                    {templateError && <div className='text-red-400 text-sm'>Template error: {templateError}</div>}
                  </div>}
                  {templateSet && !loading && <div className='ml-2 text-sm text-gray-200 flex items-center gap-2'>
                    <div className='flex items-center gap-2'>
                      <div>Preview status: <strong className='text-purple-300'>{previewStatus}</strong></div>
                      {(previewStatus === 'error' || previewStatus === 'idle') && <div className='flex items-center gap-2'>
                        <button onClick={() => {
                          setPreviewRetryKey(k => k + 1);
                        }} className='bg-purple-600 px-2 py-1 rounded hover:bg-purple-700 transition'>Retry Preview</button>
                        <RefreshCw className='w-4 h-4 text-gray-100 ml-2' />
                        {!hasPackageJson && <button onClick={() => createDefaultPackageJson()} className='bg-blue-600 px-2 py-1 rounded hover:bg-blue-700 transition text-sm'>Create package.json</button>}
                      </div>}
                    </div>
                    <div className='flex items-center gap-2'>
                      <button onClick={() => downloadZip()} className='ml-2 bg-green-600 px-2 py-1 rounded hover:bg-green-700 transition text-sm flex items-center gap-1'>
                        <DownloadCloud className='w-4 h-4 text-white' />
                        Download ZIP
                      </button>
                      {!hasPackageJson && <div className='text-yellow-400 text-xs'>No package.json detected</div>}
                    </div>
                  </div>}
                  {!(loading || !templateSet) && <div className='flex'>
                    <textarea value={userPrompt} onChange={(e) => {
                    setPrompt(e.target.value)
                  }} className='p-2 w-full'></textarea>
                    {chatError && <div className='text-red-400 text-sm'>{chatError}</div>}
                  <button onClick={async () => {
                    const newMessage = {
                      role: "user" as "user",
                      content: userPrompt
                    };
                    setLoading(true);
                    let stepsResponse;
                    try {
                      stepsResponse = await axios.post(`${BACKEND_URL}/chat`, {
                        messages: [...llmMessages, newMessage]
                      });
                    } catch (err) {
                      console.error('Chat request failed', err);
                      return;
                    } finally {
                      setLoading(false);
                    }

                    setLlmMessages(x => [...x, newMessage]);
                    setLlmMessages(x => [...x, {
                      role: "assistant",
                      content: stepsResponse.data.response
                    }]);
                    
                    setSteps(s => [...s, ...parseXml(stepsResponse.data.response).map(x => ({
                      ...x,
                      status: "pending" as "pending"
                    }))]);

                  }} className='bg-purple-400 px-4'>Send</button>
                  </div>}
                </div>
              </div>
            </div>
          </div>
          <div className="col-span-1">
              <FileExplorer 
                files={files} 
                onFileSelect={setSelectedFile}
              />
            </div>
          <div className="col-span-2 bg-gray-900 rounded-lg shadow-lg p-4 h-[calc(100vh-8rem)]">
            <TabView activeTab={activeTab} onTabChange={setActiveTab} />
            <div className="h-[calc(100%-4rem)]">
              {activeTab === 'code' ? (
                <CodeEditor file={selectedFile} />
              ) : (
                <div className='h-full flex flex-col'>
                  <div className='flex-1'>
                    <PreviewFrame webContainer={webcontainer} files={files} retryKey={previewRetryKey} onStatusChange={(s) => setPreviewStatus(s)} onRetry={() => setPreviewRetryKey(k => k + 1)} onLog={onPreviewLog} />
                  </div>
                  <div className='bg-black/20 text-xs text-gray-300 rounded p-2 h-28 overflow-auto mt-2'>
                    <div className='mb-1 font-semibold text-gray-200'>Preview logs</div>
                    <div className='flex gap-2 items-center mb-2'>
                      <button className='bg-gray-700 text-xs px-2 py-1 rounded' onClick={() => setConsoleLogs([])}>Clear logs</button>
                    </div>
                    {consoleLogs.length === 0 && <div className='text-gray-400'>No logs yet</div>}
                    {consoleLogs.map((l, idx) => <div key={idx} className='text-gray-300'>{l}</div>)}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}