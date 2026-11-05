import { useRef } from 'react';

interface ImportButtonProps {
  onFiles(files: FileList | null): void;
  className?: string;
}

/** "Import" button backed by a hidden multi-file input. Clears the input after each pick so the same file can be chosen again. */
export function ImportButton({ onFiles, className }: ImportButtonProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={className} onClick={() => input.current?.click()}>
        Import
      </button>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        multiple
        hidden
        onChange={(event) => {
          onFiles(event.target.files);
          event.target.value = '';
        }}
      />
    </>
  );
}
