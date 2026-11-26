import type { EditorView } from '@codemirror/view';
import type { Compartment } from '@codemirror/state';
// The editor's state that other parts of the page read and set: the
// language, the file, the CodeMirror instance, and Find & Replace.

export const editorState = {
  language: 'asm' as 'asm' | 'c',
  fileName: 'basic.asm',            // the default name for Save
  lastAssembledCode: null as string | null,   // the source the program was assembled from
  // Bumped on every loadExample() so a fetch that resolves after a newer
  // choice was made discards its result instead of overwriting the editor.
  exampleLoadToken: 0,
  cm: null as EditorView | null,        // the CodeMirror EditorView
  languageCompartment: null as Compartment | null, // swaps the language mode without rebuilding the editor
  find: {
    matches: [] as { start: number; end: number }[],
    activeIndex: -1,
    caseSensitive: false,
  },
};
