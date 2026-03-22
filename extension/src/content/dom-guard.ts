/**
 * Main-world DOM safety patch.
 *
 * This script runs in the PAGE's main JavaScript world (not the extension's
 * isolated content-script world) so it can intercept DOM calls made by
 * frameworks like React.
 *
 * Our content script injects anchor <span> elements into React-managed DOM
 * trees.  When React reconciles (e.g. sidebar open), it may call
 * parent.insertBefore(node, ref) where `ref` was displaced by our spans.
 * Without this patch React crashes with:
 *   NotFoundError: Failed to execute 'insertBefore' on 'Node'
 *
 * The patch adds an O(1) parentNode check and falls back gracefully.
 */
(function () {
  var origInsertBefore = Node.prototype.insertBefore;
  var origRemoveChild = Node.prototype.removeChild;

  Node.prototype.insertBefore = function <T extends Node>(
    this: Node,
    newChild: T,
    refChild: Node | null,
  ): T {
    if (refChild && refChild.parentNode !== this) {
      // refChild is not a child of this node — fall back to appendChild
      return origInsertBefore.call(this, newChild, null) as T;
    }
    return origInsertBefore.call(this, newChild, refChild) as T;
  };

  Node.prototype.removeChild = function <T extends Node>(
    this: Node,
    child: T,
  ): T {
    if (child && child.parentNode !== this) {
      // child already removed or reparented — return silently
      return child;
    }
    return origRemoveChild.call(this, child) as T;
  };
})();
