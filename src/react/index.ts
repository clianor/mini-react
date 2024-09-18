interface ComponentFunction {
  new (props: Record<string, unknown>): Component;
  (props: Record<string, unknown>): VirtualElement | string;
}
type VirtualElementType = ComponentFunction | string;

interface VirtualElementProps {
  children?: VirtualElement[];
  [propName: string]: unknown;
}
interface VirtualElement {
  type: VirtualElementType;
  props: VirtualElementProps;
}

type EffectCleanup = (() => void) | void;
type EffectCallback = () => EffectCleanup;
interface Effect {
  callback: EffectCallback;
  deps?: any[];
  cleanup: EffectCleanup;
}

type HookType = "useState" | "useEffect";
interface BaseHook {
  type: HookType;
}

interface StateHook<S> extends BaseHook {
  type: "useState";
  state?: S;
  queue?: S[];
}

interface EffectHook extends BaseHook {
  type: "useEffect";
  effect?: Effect;
}

type Hook<S = any> = StateHook<S> | EffectHook;

type FiberNodeDOM = Element | Text | null | undefined;
interface FiberNode<S = any> extends VirtualElement {
  alternate: FiberNode<S> | null;
  dom?: FiberNodeDOM;
  effectTag?: string;
  child?: FiberNode;
  return?: FiberNode;
  sibling?: FiberNode;
  hooks?: Hook<S>[];
}

// 작업 중인 루트 Fiber 노드
let wipRoot: FiberNode | null = null;
// 다음 단위 작업으로 처리해야 할 Fiber 노드
let nextUnitOfWork: FiberNode | null = null;
// 현재 루트 Fiber 노드
let currentRoot: FiberNode | null = null;
// 삭제해야 할 Fiber 노드 목록
let deletions: FiberNode[] = [];
// 작업 중인 Fiber 노드
let wipFiber: FiberNode;
// 훅 인덱스
let hookIndex = 0;
// React.Fragment 구문 지원.
const Fragment = Symbol.for("react.fragment");

// 향상된 requestIdleCallback.
((global: Window) => {
  const id = 1;
  const fps = 1e3 / 60;
  let frameDeadline: number;
  let pendingCallback: IdleRequestCallback;
  const channel = new MessageChannel();
  const timeRemaining = () => frameDeadline - window.performance.now();

  const deadline = {
    didTimeout: false,
    timeRemaining,
  };

  channel.port2.onmessage = () => {
    if (typeof pendingCallback === "function") {
      pendingCallback(deadline);
    }
  };

  global.requestIdleCallback = (callback: IdleRequestCallback) => {
    global.requestAnimationFrame((frameTime) => {
      frameDeadline = frameTime + fps;
      pendingCallback = callback;
      channel.port1.postMessage(null);
    });
    return id;
  };
})(window);

const isDef = <T>(param: T): param is NonNullable<T> =>
  param !== void 0 && param !== null;

const isPlainObject = (val: unknown): val is Record<string, unknown> =>
  Object.prototype.toString.call(val) === "[object Object]" &&
  [Object.prototype, null].includes(Object.getPrototypeOf(val));

// 가상 요소의 간단한 판단.
const isVirtualElement = (e: unknown): e is VirtualElement =>
  typeof e === "object";

// 텍스트 요소는 특별한 처리가 필요합니다.
const createTextElement = (text: string): VirtualElement => ({
  type: "TEXT",
  props: {
    nodeValue: text,
  },
});

// 사용자 지정 JavaScript 데이터 구조를 생성합니다.
const createElement = (
  type: VirtualElementType,
  props: Record<string, unknown> = {},
  ...child: (unknown | VirtualElement)[]
): VirtualElement => {
  const children = child
    .filter(Boolean)
    .map((c) => (isVirtualElement(c) ? c : createTextElement(String(c))));

  return {
    type,
    props: {
      ...props,
      children,
    },
  };
};

// DOM 속성을 업데이트합니다.
// 단순화를 위해 이전 모든 속성을 제거하고 다음 속성을 추가합니다.
const updateDOM = (
  DOM: NonNullable<FiberNodeDOM>,
  prevProps: VirtualElementProps,
  nextProps: VirtualElementProps
) => {
  const defaultPropKeys = "children";

  for (const [removePropKey, removePropValue] of Object.entries(prevProps)) {
    if (removePropKey.startsWith("on")) {
      DOM.removeEventListener(
        removePropKey.slice(2).toLowerCase(),
        removePropValue as EventListener
      );
    } else if (removePropKey !== defaultPropKeys) {
      // @ts-expect-error: Unreachable code error
      DOM[removePropKey] = "";
    }
  }

  for (const [addPropKey, addPropValue] of Object.entries(nextProps)) {
    if (addPropKey.startsWith("on")) {
      DOM.addEventListener(
        addPropKey.slice(2).toLowerCase(),
        addPropValue as EventListener
      );
    } else if (addPropKey !== defaultPropKeys) {
      // @ts-expect-error: Unreachable code error
      DOM[addPropKey] = addPropValue;
    }
  }
};

// 노드 타입에 기반하여 DOM을 생성합니다.
const createDOM = (fiberNode: FiberNode): FiberNodeDOM => {
  const { type, props } = fiberNode;
  let DOM: FiberNodeDOM = null;

  if (type === "TEXT") {
    DOM = document.createTextNode("");
  } else if (typeof type === "string") {
    DOM = document.createElement(type);
  }
  // 생성 후 props에 기반하여 속성을 업데이트합니다.
  if (DOM !== null) {
    updateDOM(DOM, {}, props);
  }

  return DOM;
};

// Fiber 노드 변경에 기반하여 DOM을 변경합니다.
// commitRoot를 실행하기 전에 모든 Fiber 노드의 비교를 완료해야 합니다.
// Fiber 노드의 비교는 중단될 수 있지만, commitRoot는 중단될 수 없습니다.
const commitRoot = () => {
  // Fiber 노드의 부모를 찾습니다.
  const findParentFiber = (fiberNode?: FiberNode) => {
    if (fiberNode) {
      let parentFiber = fiberNode.return;
      while (parentFiber && !parentFiber.dom) {
        parentFiber = parentFiber.return;
      }
      return parentFiber;
    }

    return null;
  };

  // 노드를 삭제합니다.
  const commitDeletion = (
    parentDOM: FiberNodeDOM,
    DOM: NonNullable<FiberNodeDOM>
  ) => {
    if (isDef(parentDOM)) {
      parentDOM.removeChild(DOM);
    }
  };

  // 노드를 추가합니다.
  const commitReplacement = (
    parentDOM: FiberNodeDOM,
    DOM: NonNullable<FiberNodeDOM>
  ) => {
    if (isDef(parentDOM)) {
      parentDOM.appendChild(DOM);
    }
  };

  // 노드를 업데이트합니다.
  const commitWork = (fiberNode?: FiberNode) => {
    if (fiberNode) {
      if (fiberNode.dom) {
        const parentFiber = findParentFiber(fiberNode);
        const parentDOM = parentFiber?.dom;

        switch (fiberNode.effectTag) {
          case "REPLACEMENT":
            commitReplacement(parentDOM, fiberNode.dom);
            break;
          case "UPDATE":
            updateDOM(
              fiberNode.dom,
              fiberNode.alternate ? fiberNode.alternate.props : {},
              fiberNode.props
            );
            break;
          default:
            break;
        }
      }

      commitWork(fiberNode.child);
      commitWork(fiberNode.sibling);
    }
  };

  // 노드를 삭제합니다.
  deletions.forEach((deletion) => {
    if (deletion.dom) {
      const parentFiber = findParentFiber(deletion);
      commitDeletion(parentFiber?.dom, deletion.dom);
    } else if (deletion.child && deletion.child.dom) {
      const parentFiber = findParentFiber(deletion);
      commitDeletion(parentFiber?.dom, deletion.child.dom);
    }
  });

  // 노드를 추가합니다.
  if (wipRoot !== null) {
    commitWork(wipRoot.child);
    currentRoot = wipRoot;
  }

  wipRoot = null;
};

// 이전과 이후의 Fiber 노드를 조정하여 차이점을 비교하고 기록합니다.
const reconcileChildren = (
  fiberNode: FiberNode,
  elements: VirtualElement[] = []
) => {
  let index = 0;
  let oldFiberNode: FiberNode | undefined = void 0;
  let prevSibling: FiberNode | undefined = void 0;
  const virtualElements = elements.flat(Infinity);

  if (fiberNode.alternate?.child) {
    oldFiberNode = fiberNode.alternate.child;
  }

  while (
    index < virtualElements.length ||
    typeof oldFiberNode !== "undefined"
  ) {
    const virtualElement = virtualElements[index];
    let newFiber: FiberNode | undefined = void 0;

    const isSameType = Boolean(
      oldFiberNode &&
        virtualElement &&
        oldFiberNode.type === virtualElement.type
    );

    if (isSameType && oldFiberNode) {
      newFiber = {
        type: oldFiberNode.type,
        dom: oldFiberNode.dom,
        alternate: oldFiberNode,
        props: virtualElement.props,
        return: fiberNode,
        effectTag: "UPDATE",
      };
    }
    if (!isSameType && Boolean(virtualElement)) {
      newFiber = {
        type: virtualElement.type,
        dom: null,
        alternate: null,
        props: virtualElement.props,
        return: fiberNode,
        effectTag: "REPLACEMENT",
      };
    }
    if (!isSameType && oldFiberNode) {
      const oldEffectHooks = oldFiberNode.hooks?.filter(
        (hook) => hook.type === "useEffect"
      );
      oldEffectHooks?.forEach((hook) => {
        if (hook.effect?.cleanup) {
          hook.effect.cleanup();
        }
      });
      deletions.push(oldFiberNode);
    }

    if (oldFiberNode) {
      oldFiberNode = oldFiberNode.sibling;
    }

    if (index === 0) {
      fiberNode.child = newFiber;
    } else if (typeof prevSibling !== "undefined") {
      prevSibling.sibling = newFiber;
    }

    prevSibling = newFiber;
    index += 1;
  }
};

// 각 단위 작업을 실행하고 다음 단위 작업으로 돌아갑니다.
// Fiber 노드의 타입에 따라 다른 처리를 합니다.
const performUnitOfWork = (fiberNode: FiberNode): FiberNode | null => {
  const { type } = fiberNode;
  switch (typeof type) {
    case "function": {
      wipFiber = fiberNode;
      wipFiber.hooks = [];
      hookIndex = 0;
      let children: ReturnType<ComponentFunction>;

      if (Object.getPrototypeOf(type).REACT_COMPONENT) {
        const C = type;
        const component = new C(fiberNode.props);
        const [state, setState] = useState(component.state);
        component.props = fiberNode.props;
        component.state = state;
        component.setState = setState;
        children = component.render.bind(component)();
      } else {
        children = type(fiberNode.props);
      }
      reconcileChildren(fiberNode, [
        isVirtualElement(children)
          ? children
          : createTextElement(String(children)),
      ]);
      break;
    }

    case "number":
    case "string":
      if (!fiberNode.dom) {
        fiberNode.dom = createDOM(fiberNode);
      }
      reconcileChildren(fiberNode, fiberNode.props.children);
      break;
    case "symbol":
      if (type === Fragment) {
        reconcileChildren(fiberNode, fiberNode.props.children);
      }
      break;
    default:
      if (typeof fiberNode.props !== "undefined") {
        reconcileChildren(fiberNode, fiberNode.props.children);
      }
      break;
  }

  if (fiberNode.child) {
    return fiberNode.child;
  }

  let nextFiberNode: FiberNode | undefined = fiberNode;

  while (typeof nextFiberNode !== "undefined") {
    if (nextFiberNode.sibling) {
      return nextFiberNode.sibling;
    }

    nextFiberNode = nextFiberNode.return;
  }

  return null;
};

// requestIdleCallback를 사용하여 현재 단위 작업이 있는지 쿼리하고
// DOM을 업데이트해야 하는지 여부를 결정합니다.
const workLoop: IdleRequestCallback = (deadline) => {
  while (nextUnitOfWork && deadline.timeRemaining() > 1) {
    nextUnitOfWork = performUnitOfWork(nextUnitOfWork);
  }

  // 현재 진행할 작업이 없고, 루트가 존재할 때, commitRoot를 실행합니다.
  if (!nextUnitOfWork && wipRoot) {
    commitRoot();
  }

  window.requestIdleCallback(workLoop);
};

// 초기화 또는 재설정.
const render = (element: VirtualElement, container: Element) => {
  currentRoot = null;
  wipRoot = {
    type: "div",
    dom: container,
    props: {
      children: [{ ...element }],
    },
    alternate: currentRoot,
  };
  nextUnitOfWork = wipRoot;
  deletions = [];
};

abstract class Component {
  props: Record<string, unknown>;
  abstract state: unknown;
  abstract setState: (value: unknown) => void;
  abstract render: () => VirtualElement;

  constructor(props: Record<string, unknown>) {
    this.props = props;
  }

  // 컴포넌트를 식별합니다.
  static REACT_COMPONENT = true;
}

// 훅을 Fiber 노드와 연결합니다.
export function useState<S>(initState: S): [S, (value: S) => void] {
  const fiberNode: FiberNode<S> = wipFiber;
  const hook: Hook<S> = fiberNode?.alternate?.hooks
    ? fiberNode.alternate.hooks[hookIndex]
    : {
        type: "useState",
        state: initState,
        queue: [],
      };

  if (hook.type !== "useState") {
    throw new Error("useState hook is not found");
  }

  while (hook.queue && hook.queue.length) {
    let newState = hook.queue.shift();
    if (isPlainObject(hook.state) && isPlainObject(newState)) {
      newState = { ...hook.state, ...newState };
    }
    if (isDef(newState)) {
      hook.state = newState;
    }
  }

  if (typeof fiberNode.hooks === "undefined") {
    fiberNode.hooks = [];
  }

  fiberNode.hooks.push(hook);
  hookIndex += 1;

  const setState = (value: S) => {
    if (hook.queue) {
      hook.queue.push(value);
    }
    if (currentRoot) {
      wipRoot = {
        type: currentRoot.type,
        dom: currentRoot.dom,
        props: currentRoot.props,
        alternate: currentRoot,
      };
      nextUnitOfWork = wipRoot;
      deletions = [];
      currentRoot = null;
    }
  };

  return [hook.state as S, setState];
}

export function useEffect(callback: Effect["callback"], deps?: any[]) {
  const fiberNode: FiberNode = wipFiber;
  const hook: Hook = fiberNode?.alternate?.hooks
    ? fiberNode.alternate.hooks[hookIndex]
    : { type: "useEffect" };
  const effect: Effect = { callback, deps, cleanup: undefined };

  if (hook.type !== "useEffect") {
    throw new Error("useEffect hook is not found");
  }

  const oldEffect = hook.effect;
  if (oldEffect) {
    if (!deps || !oldEffect.deps || !areDepsEqual(deps, oldEffect.deps)) {
      if (oldEffect.cleanup) {
        oldEffect.cleanup();
      }
      effect.cleanup = callback() || undefined;
      hook.effect = effect;
    }
  } else {
    effect.cleanup = callback() || undefined;
    hook.effect = effect;
  }

  if (typeof fiberNode.hooks === "undefined") {
    fiberNode.hooks = [];
  }

  fiberNode.hooks.push(hook);
  hookIndex += 1;
}

function areDepsEqual(oldDeps: any[], newDeps: any[]): boolean {
  if (oldDeps.length !== newDeps.length) return false;
  return oldDeps.every((dep, i) => dep === newDeps[i]);
}

// 엔진 시작
void (function main() {
  window.requestIdleCallback(workLoop);
})();

export default {
  createElement,
  render,
  useState,
  useEffect,
  Component,
  Fragment,
};
