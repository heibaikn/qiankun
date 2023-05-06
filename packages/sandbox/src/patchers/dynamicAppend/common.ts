/**
 * @author Kuitos
 * @since 2019-10-21
 */
import { transpileAssets } from '@qiankunjs/shared';
import { qiankunHeadTagName } from '../consts';
import type { SandboxConfig } from './types';

const SCRIPT_TAG_NAME = 'SCRIPT';
const LINK_TAG_NAME = 'LINK';
const STYLE_TAG_NAME = 'STYLE';

export const styleElementTargetSymbol = Symbol('target');
const overwrittenSymbol = Symbol('qiankun-overwritten');

type DynamicDomMutationTarget = 'head' | 'body';

declare global {
  interface HTMLLinkElement {
    [styleElementTargetSymbol]: DynamicDomMutationTarget;
  }

  interface HTMLStyleElement {
    [styleElementTargetSymbol]: DynamicDomMutationTarget;
  }

  interface Function {
    [overwrittenSymbol]: boolean;
  }
}

export const getContainerHeadElement = (container: Element | ShadowRoot): Element => {
  return container.querySelector(qiankunHeadTagName)!;
};

export function isExecutableScriptType(script: HTMLScriptElement) {
  return (
    !script.type ||
    ['text/javascript', 'module', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].indexOf(
      script.type,
    ) !== -1
  );
}

export function isHijackingTag(tagName?: string) {
  return (
    tagName?.toUpperCase() === LINK_TAG_NAME ||
    tagName?.toUpperCase() === STYLE_TAG_NAME ||
    tagName?.toUpperCase() === SCRIPT_TAG_NAME
  );
}

/**
 * Check if a style element is a styled-component liked.
 * A styled-components liked element is which not have textContext but keep the rules in its styleSheet.cssRules.
 * Such as the style element generated by styled-components and emotion.
 * @param element
 */
export function isStyledComponentsLike(element: HTMLStyleElement) {
  return (
    !element.textContent &&
    ((element.sheet as CSSStyleSheet)?.cssRules.length || getStyledElementCSSRules(element)?.length)
  );
}

const appsCounterMap = new Map<string, { bootstrappingPatchCount: number; mountingPatchCount: number }>();

export function calcAppCount(
  appName: string,
  calcType: 'increase' | 'decrease',
  status: 'bootstrapping' | 'mounting',
): void {
  const appCount = appsCounterMap.get(appName) || { bootstrappingPatchCount: 0, mountingPatchCount: 0 };
  switch (calcType) {
    case 'increase':
      appCount[`${status}PatchCount`] += 1;
      break;
    case 'decrease':
      // bootstrap patch just called once but its freer will be called multiple times
      if (appCount[`${status}PatchCount`] > 0) {
        appCount[`${status}PatchCount`] -= 1;
      }
      break;
  }
  appsCounterMap.set(appName, appCount);
}

export function isAllAppsUnmounted(): boolean {
  return Array.from(appsCounterMap.entries()).every(
    ([, { bootstrappingPatchCount: bpc, mountingPatchCount: mpc }]) => bpc === 0 && mpc === 0,
  );
}

const styledComponentCSSRulesMap = new WeakMap<HTMLStyleElement, CSSRuleList>();
const dynamicScriptAttachedCommentMap = new WeakMap<HTMLScriptElement, Comment>();
const dynamicLinkAttachedInlineStyleMap = new WeakMap<HTMLLinkElement, HTMLStyleElement>();

export function recordStyledComponentsCSSRules(styleElements: HTMLStyleElement[]): void {
  styleElements.forEach((styleElement) => {
    /*
     With a styled-components generated style element, we need to record its cssRules for restore next re-mounting time.
     We're doing this because the sheet of style element is going to be cleaned automatically by browser after the style element dom removed from document.
     see https://www.w3.org/TR/cssom-1/#associated-css-style-sheet
     */
    if (styleElement instanceof HTMLStyleElement && isStyledComponentsLike(styleElement)) {
      if (styleElement.sheet) {
        // record the original css rules of the style element for restore
        styledComponentCSSRulesMap.set(styleElement, (styleElement.sheet as CSSStyleSheet).cssRules);
      }
    }
  });
}

export function getStyledElementCSSRules(styledElement: HTMLStyleElement): CSSRuleList | undefined {
  return styledComponentCSSRulesMap.get(styledElement);
}

function getOverwrittenAppendChildOrInsertBefore(opts: {
  rawDOMAppendOrInsertBefore: <T extends Node>(newChild: T, refChild?: Node | null) => T;
  isInvokedByMicroApp: (element: HTMLElement) => boolean;
  getSandboxConfig: (element: HTMLElement) => SandboxConfig;
  target: DynamicDomMutationTarget;
}) {
  function appendChildOrInsertBefore<T extends Node>(
    this: HTMLHeadElement | HTMLBodyElement,
    newChild: T,
    refChild: Node | null = null,
  ) {
    const element = newChild as any;
    const { rawDOMAppendOrInsertBefore, isInvokedByMicroApp, getSandboxConfig, target = 'body' } = opts;
    if (!isHijackingTag(element.tagName) || !isInvokedByMicroApp(element)) {
      return rawDOMAppendOrInsertBefore.call(this, element, refChild) as T;
    }

    if (element.tagName) {
      const containerConfig = getSandboxConfig(element);
      const { getContainer, dynamicStyleSheetElements, sandbox } = containerConfig;

      switch (element.tagName) {
        case LINK_TAG_NAME:
        case STYLE_TAG_NAME: {
          const stylesheetElement: HTMLLinkElement | HTMLStyleElement = newChild as any;
          Object.defineProperty(stylesheetElement, styleElementTargetSymbol, {
            value: target,
            writable: true,
            configurable: true,
          });

          const container = getContainer();
          // const mountDOM = target === 'head' ? getContainerHeadElement(container) : container;
          const mountDOM = container;

          dynamicStyleSheetElements.push(stylesheetElement);
          const referenceNode = mountDOM.contains(refChild) ? refChild : null;
          return rawDOMAppendOrInsertBefore.call(mountDOM, stylesheetElement, referenceNode);
        }

        case SCRIPT_TAG_NAME: {
          const container = getContainer();
          // const mountDOM = target === 'head' ? getContainerHeadElement(container) : container;
          const mountDOM = container;
          const referenceNode = mountDOM.contains(refChild) ? refChild : null;

          // TODO paas fetch configuration and current entry url as baseURI
          const node = transpileAssets(element, location.href, { fetch, sandbox });

          return rawDOMAppendOrInsertBefore.call(mountDOM, node, referenceNode);
        }

        default:
          break;
      }
    }

    return rawDOMAppendOrInsertBefore.call(this, element, refChild);
  }

  appendChildOrInsertBefore[overwrittenSymbol] = true;

  return appendChildOrInsertBefore;
}

function getNewRemoveChild(
  rawRemoveChild: typeof HTMLElement.prototype.removeChild,
  containerConfigGetter: (element: HTMLElement) => SandboxConfig,
  target: DynamicDomMutationTarget,
  isInvokedByMicroApp: (element: HTMLElement) => boolean,
) {
  function removeChild<T extends Node>(this: HTMLHeadElement | HTMLBodyElement, child: T) {
    const { tagName } = child as any;
    if (!isHijackingTag(tagName) || !isInvokedByMicroApp(child as any)) return rawRemoveChild.call(this, child) as T;

    try {
      let attachedElement: Node;
      const { getContainer, dynamicStyleSheetElements } = containerConfigGetter(child as any);

      switch (tagName) {
        case STYLE_TAG_NAME:
        case LINK_TAG_NAME: {
          attachedElement = dynamicLinkAttachedInlineStyleMap.get(child as any) || child;

          // try to remove the dynamic style sheet
          const dynamicElementIndex = dynamicStyleSheetElements.indexOf(attachedElement as HTMLLinkElement);
          if (dynamicElementIndex !== -1) {
            dynamicStyleSheetElements.splice(dynamicElementIndex, 1);
          }

          break;
        }

        case SCRIPT_TAG_NAME: {
          attachedElement = dynamicScriptAttachedCommentMap.get(child as any) || child;
          break;
        }

        default: {
          attachedElement = child;
        }
      }

      const appWrapper = getContainer();
      // const container = target === 'head' ? getContainerHeadElement(appWrapper) : appWrapper;
      const container = appWrapper;
      // container might have been removed while app unmounting if the removeChild action was async
      if (container.contains(attachedElement)) {
        return rawRemoveChild.call(attachedElement.parentNode, attachedElement) as T;
      }
    } catch (e) {
      console.warn(e);
    }

    return rawRemoveChild.call(this, child) as T;
  }

  removeChild[overwrittenSymbol] = true;
  return removeChild;
}

export function patchHTMLDynamicAppendPrototypeFunctions(
  isInvokedByMicroApp: (element: HTMLElement) => boolean,
  getSandboxConfig: (element: HTMLElement) => SandboxConfig,
) {
  const rawHeadAppendChild = HTMLHeadElement.prototype.appendChild;
  const rawBodyAppendChild = HTMLBodyElement.prototype.appendChild;
  const rawHeadInsertBefore = HTMLHeadElement.prototype.insertBefore;

  // Just overwrite it while it have not been overwritten
  if (
    rawHeadAppendChild[overwrittenSymbol] !== true &&
    rawBodyAppendChild[overwrittenSymbol] !== true &&
    rawHeadInsertBefore[overwrittenSymbol] !== true
  ) {
    HTMLHeadElement.prototype.appendChild = getOverwrittenAppendChildOrInsertBefore({
      rawDOMAppendOrInsertBefore: rawHeadAppendChild,
      getSandboxConfig: getSandboxConfig,
      isInvokedByMicroApp,
      target: 'head',
    }) as typeof rawHeadAppendChild;
    HTMLBodyElement.prototype.appendChild = getOverwrittenAppendChildOrInsertBefore({
      rawDOMAppendOrInsertBefore: rawBodyAppendChild,
      getSandboxConfig: getSandboxConfig,
      isInvokedByMicroApp,
      target: 'body',
    }) as typeof rawBodyAppendChild;

    HTMLHeadElement.prototype.insertBefore = getOverwrittenAppendChildOrInsertBefore({
      rawDOMAppendOrInsertBefore: rawHeadInsertBefore as any,
      getSandboxConfig: getSandboxConfig,
      isInvokedByMicroApp,
      target: 'head',
    }) as typeof rawHeadInsertBefore;
  }

  const rawHeadRemoveChild = HTMLHeadElement.prototype.removeChild;
  const rawBodyRemoveChild = HTMLBodyElement.prototype.removeChild;
  // Just overwrite it while it have not been overwritten
  if (rawHeadRemoveChild[overwrittenSymbol] !== true && rawBodyRemoveChild[overwrittenSymbol] !== true) {
    HTMLHeadElement.prototype.removeChild = getNewRemoveChild(
      rawHeadRemoveChild,
      getSandboxConfig,
      'head',
      isInvokedByMicroApp,
    );
    HTMLBodyElement.prototype.removeChild = getNewRemoveChild(
      rawBodyRemoveChild,
      getSandboxConfig,
      'body',
      isInvokedByMicroApp,
    );
  }

  return function unpatch() {
    HTMLHeadElement.prototype.appendChild = rawHeadAppendChild;
    HTMLHeadElement.prototype.removeChild = rawHeadRemoveChild;
    HTMLBodyElement.prototype.appendChild = rawBodyAppendChild;
    HTMLBodyElement.prototype.removeChild = rawBodyRemoveChild;

    HTMLHeadElement.prototype.insertBefore = rawHeadInsertBefore;
  };
}

export function rebuildCSSRules(
  styleSheetElements: HTMLStyleElement[],
  reAppendElement: (stylesheetElement: HTMLStyleElement) => boolean,
) {
  styleSheetElements.forEach((stylesheetElement) => {
    // re-append the dynamic stylesheet to sub-app container
    const appendSuccess = reAppendElement(stylesheetElement);
    if (appendSuccess) {
      /*
      get the stored css rules from styled-components generated element, and the re-insert rules for them.
      note that we must do this after style element had been added to document, which stylesheet would be associated to the document automatically.
      check the spec https://www.w3.org/TR/cssom-1/#associated-css-style-sheet
       */
      if (stylesheetElement instanceof HTMLStyleElement && isStyledComponentsLike(stylesheetElement)) {
        const cssRules = getStyledElementCSSRules(stylesheetElement);
        if (cssRules) {
          // eslint-disable-next-line no-plusplus
          for (let i = 0; i < cssRules.length; i++) {
            const cssRule = cssRules[i];
            const cssStyleSheetElement = stylesheetElement.sheet as CSSStyleSheet;
            cssStyleSheetElement.insertRule(cssRule.cssText, cssStyleSheetElement.cssRules.length);
          }
        }
      }
    }
  });
}