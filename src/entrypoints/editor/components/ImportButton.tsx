import { useRef } from 'react';

interface ImportButtonProps {
  onFiles(files: FileList | null): void;
  className?: string;
}

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
