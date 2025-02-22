import { global } from '@storybook/global';

import type {
  Renderer,
  Args,
  ArgsStoryFn,
  LegacyStoryFn,
  Parameters,
  PlayFunction,
  PlayFunctionContext,
  StepLabel,
  NormalizedComponentAnnotations,
  NormalizedProjectAnnotations,
  NormalizedStoryAnnotations,
  PreparedStory,
  StoryContext,
  StoryContextForEnhancers,
  StoryContextForLoaders,
  StrictArgTypes,
  PreparedMeta,
  ModuleExport,
} from '@storybook/types';
import { includeConditionalArg } from '@storybook/csf';

import { applyHooks } from '../../addons';
import { combineParameters } from '../parameters';
import { defaultDecorateStory } from '../decorators';
import { groupArgsByTarget, UNTARGETED } from '../args';

// Combine all the metadata about a story (both direct and inherited from the component/global scope)
// into a "renderable" story function, with all decorators applied, parameters passed as context etc
//
// Note that this story function is *stateless* in the sense that it does not track args or globals
// Instead, it is expected these are tracked separately (if necessary) and are passed into each invocation.
export function prepareStory<TRenderer extends Renderer>(
  storyAnnotations: NormalizedStoryAnnotations<TRenderer>,
  componentAnnotations: NormalizedComponentAnnotations<TRenderer>,
  projectAnnotations: NormalizedProjectAnnotations<TRenderer>
): PreparedStory<TRenderer> {
  // NOTE: in the current implementation we are doing everything once, up front, rather than doing
  // anything at render time. The assumption is that as we don't load all the stories at once, this
  // will have a limited cost. If this proves misguided, we can refactor it.
  const { moduleExport, id, name } = storyAnnotations || {};

  const partialAnnotations = preparePartialAnnotations(
    storyAnnotations,
    componentAnnotations,
    projectAnnotations
  );

  const loaders = [
    ...(projectAnnotations.loaders || []),
    ...(componentAnnotations.loaders || []),
    ...(storyAnnotations?.loaders || []),
  ];
  const applyLoaders = async (context: StoryContextForLoaders<TRenderer>) => {
    const loadResults = await Promise.all(loaders.map((loader) => loader(context)));
    const loaded = Object.assign({}, ...loadResults);
    return { ...context, loaded };
  };

  const undecoratedStoryFn: LegacyStoryFn<TRenderer> = (context: StoryContext<TRenderer>) => {
    const { passArgsFirst: renderTimePassArgsFirst = true } = context.parameters;
    return renderTimePassArgsFirst
      ? (render as ArgsStoryFn<TRenderer>)(context.args, context)
      : (render as LegacyStoryFn<TRenderer>)(context);
  };

  // Currently it is only possible to set these globally
  const { applyDecorators = defaultDecorateStory, runStep } = projectAnnotations;

  const decorators = [
    ...(storyAnnotations?.decorators || []),
    ...(componentAnnotations.decorators || []),
    ...(projectAnnotations.decorators || []),
  ];

  // The render function on annotations *has* to be an `ArgsStoryFn`, so when we normalize
  // CSFv1/2, we use a new field called `userStoryFn` so we know that it can be a LegacyStoryFn
  const render =
    storyAnnotations?.userStoryFn ||
    storyAnnotations?.render ||
    componentAnnotations.render ||
    projectAnnotations.render;
  if (!render) throw new Error(`No render function available for storyId '${id}'`);

  const decoratedStoryFn = applyHooks<TRenderer>(applyDecorators)(undecoratedStoryFn, decorators);
  const unboundStoryFn = (context: StoryContext<TRenderer>) => decoratedStoryFn(context);

  const play = storyAnnotations?.play || componentAnnotations.play;

  const playFunction =
    play &&
    (async (storyContext: StoryContext<TRenderer>) => {
      // When lazy loaded, or under other conditions perhaps like stories with excessive Context providers in React
      // the canvasElement may be defined, but empty for a varying amount of time. We will provide an automatic
      // backoff delay (with limits) to allow the story time to render before play can be initiated.
      await delayForCanvas<TRenderer>(storyContext.canvasElement);

      const playFunctionContext: PlayFunctionContext<TRenderer> = {
        ...storyContext,
        // eslint-disable-next-line @typescript-eslint/no-shadow
        step: (label: StepLabel, play: PlayFunction<TRenderer>) =>
          // TODO: We know runStep is defined, we need a proper normalized annotations type
          runStep!(label, play, playFunctionContext),
      };
      return play(playFunctionContext);
    });

  return {
    ...partialAnnotations,
    moduleExport,
    id,
    name,
    story: name,
    originalStoryFn: render,
    undecoratedStoryFn,
    unboundStoryFn,
    applyLoaders,
    playFunction,
  };
}

export const getTriangularNumber = (seed: number) => (seed * (seed + 1)) / 2;

export const delayForCanvas = async <TRenderer extends Renderer>(
  canvasElement: TRenderer['canvasElement']
) => {
  let backOff = 0;
  // @ts-expect-error Renderer uses canvasElement: unknown, but we know it's a div.
  while (!canvasElement.innerHTML) {
    backOff += 1;
    if (backOff > 100) {
      throw new Error('canvasElement.innerHTML did not populate after 100 increasing delays');
    }
    // eslint-disable-next-line no-await-in-loop,@typescript-eslint/no-loop-func
    await new Promise((resolve) => setTimeout(resolve, getTriangularNumber(backOff)));
  }
};

export function prepareMeta<TRenderer extends Renderer>(
  componentAnnotations: NormalizedComponentAnnotations<TRenderer>,
  projectAnnotations: NormalizedProjectAnnotations<TRenderer>,
  moduleExport: ModuleExport
): PreparedMeta<TRenderer> {
  return {
    ...preparePartialAnnotations(undefined, componentAnnotations, projectAnnotations),
    moduleExport,
  };
}

function preparePartialAnnotations<TRenderer extends Renderer>(
  storyAnnotations: NormalizedStoryAnnotations<TRenderer> | undefined,
  componentAnnotations: NormalizedComponentAnnotations<TRenderer>,
  projectAnnotations: NormalizedProjectAnnotations<TRenderer>
): Omit<StoryContextForEnhancers<TRenderer>, 'name' | 'story'> {
  // NOTE: in the current implementation we are doing everything once, up front, rather than doing
  // anything at render time. The assumption is that as we don't load all the stories at once, this
  // will have a limited cost. If this proves misguided, we can refactor it.

  const tags = [...(storyAnnotations?.tags || componentAnnotations.tags || []), 'story'];

  const parameters: Parameters = combineParameters(
    projectAnnotations.parameters,
    componentAnnotations.parameters,
    storyAnnotations?.parameters
  );

  // Currently it is only possible to set these globally
  const { argTypesEnhancers = [], argsEnhancers = [] } = projectAnnotations;

  const passedArgTypes: StrictArgTypes = combineParameters(
    projectAnnotations.argTypes,
    componentAnnotations.argTypes,
    storyAnnotations?.argTypes
  ) as StrictArgTypes;

  if (storyAnnotations) {
    // The render function on annotations *has* to be an `ArgsStoryFn`, so when we normalize
    // CSFv1/2, we use a new field called `userStoryFn` so we know that it can be a LegacyStoryFn
    const render =
      storyAnnotations?.userStoryFn ||
      storyAnnotations?.render ||
      componentAnnotations.render ||
      projectAnnotations.render;

    const { passArgsFirst = true } = parameters;

    // eslint-disable-next-line no-underscore-dangle
    parameters.__isArgsStory = passArgsFirst && render && render.length > 0;
  }

  // Pull out args[X] into initialArgs for argTypes enhancers
  const passedArgs: Args = {
    ...projectAnnotations.args,
    ...componentAnnotations.args,
    ...storyAnnotations?.args,
  } as Args;

  const contextForEnhancers: StoryContextForEnhancers<TRenderer> = {
    componentId: componentAnnotations.id,
    title: componentAnnotations.title,
    kind: componentAnnotations.title, // Back compat
    id: storyAnnotations?.id || componentAnnotations.id,
    // if there's no story name, we create a fake one since enhancers expect a name
    name: storyAnnotations?.name || '__meta',
    story: storyAnnotations?.name || '__meta', // Back compat
    component: componentAnnotations.component,
    subcomponents: componentAnnotations.subcomponents,
    tags,
    parameters,
    initialArgs: passedArgs,
    argTypes: passedArgTypes,
  };

  contextForEnhancers.argTypes = argTypesEnhancers.reduce(
    (accumulatedArgTypes, enhancer) =>
      enhancer({ ...contextForEnhancers, argTypes: accumulatedArgTypes }),
    contextForEnhancers.argTypes
  );

  const initialArgsBeforeEnhancers = { ...passedArgs };

  contextForEnhancers.initialArgs = argsEnhancers.reduce(
    (accumulatedArgs: Args, enhancer) => ({
      ...accumulatedArgs,
      ...enhancer({
        ...contextForEnhancers,
        initialArgs: accumulatedArgs,
      }),
    }),
    initialArgsBeforeEnhancers
  );

  const { name, story, ...withoutStoryIdentifiers } = contextForEnhancers;

  return withoutStoryIdentifiers;
}

// the context is prepared before invoking the render function, instead of here directly
// to ensure args don't loose there special properties set by the renderer
// eg. reactive proxies set by frameworks like SolidJS or Vue
export function prepareContext<
  TRenderer extends Renderer,
  TContext extends Pick<StoryContextForLoaders<TRenderer>, 'args' | 'argTypes' | 'globals'>
>(
  context: TContext
): TContext & Pick<StoryContextForLoaders<TRenderer>, 'allArgs' | 'argsByTarget' | 'unmappedArgs'> {
  const { args: unmappedArgs } = context;

  let targetedContext: TContext &
    Pick<StoryContextForLoaders<TRenderer>, 'allArgs' | 'argsByTarget'> = {
    ...context,
    allArgs: undefined,
    argsByTarget: undefined,
  };
  if (global.FEATURES?.argTypeTargetsV7) {
    const argsByTarget = groupArgsByTarget(context);
    targetedContext = {
      ...context,
      allArgs: context.args,
      argsByTarget,
      args: argsByTarget[UNTARGETED] || {},
    };
  }

  const mappedArgs = Object.entries(targetedContext.args).reduce((acc, [key, val]) => {
    if (!targetedContext.argTypes[key]?.mapping) {
      acc[key] = val;

      return acc;
    }

    const mappingFn = (originalValue: any) =>
      originalValue in targetedContext.argTypes[key].mapping
        ? targetedContext.argTypes[key].mapping[originalValue]
        : originalValue;

    acc[key] = Array.isArray(val) ? val.map(mappingFn) : mappingFn(val);

    return acc;
  }, {} as Args);

  const includedArgs = Object.entries(mappedArgs).reduce((acc, [key, val]) => {
    const argType = targetedContext.argTypes[key] || {};
    if (includeConditionalArg(argType, mappedArgs, targetedContext.globals)) acc[key] = val;
    return acc;
  }, {} as Args);

  return { ...targetedContext, unmappedArgs, args: includedArgs };
}
