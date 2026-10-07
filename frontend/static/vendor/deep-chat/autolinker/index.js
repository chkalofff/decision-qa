// WARNING: This file is modified a bit when it is compiled into index.js in
// order to support nodejs interoperability with require('autolinker') directly.
// This is done by the buildSrcFixCommonJsIndexTask() function in the gulpfile.
// See that function for more details.
import Autolinker from './autolinker.js';
export default Autolinker;
export { Autolinker };
export * from './autolinker.js';
export * from './anchor-tag-builder.js';
export * from './html-tag.js';
export * from './match/index.js';
export * from './parser/index.js';
//# sourceMappingURL=index.js.map