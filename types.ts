
export interface IdeaSnippet {
  id: string;
  text: string;
  timestamp: Date;
}

export interface TranscriptionState {
  currentText: string;
  history: IdeaSnippet[];
  isRecording: boolean;
  status: 'idle' | 'connecting' | 'listening' | 'error';
}
