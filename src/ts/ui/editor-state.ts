// The editor's state that other parts of the page read and set: the
// language, the file, the CodeMirror instance, and Find & Replace.

export const editorState = {
  language: 'asm' as 'asm' | 'c',
  fileName: 'basic.asm',            // the default name for Save
  lastAssembledCode: null as string | null,   // the source the program was assembled from
  // Bumped on every loadExample() so a fetch that resolves after a newer
  // choice was made discards its result instead of overwriting the editor.
  exampleLoadToken: 0,
  cm: null as any,                  // the CodeMirror EditorView
  languageCompartment: null as any, // swaps the language mode without rebuilding the editor
  find: {
    matches: [] as { from: number; to: number }[],
    activeIndex: -1,
    caseSensitive: false,
  },
};
