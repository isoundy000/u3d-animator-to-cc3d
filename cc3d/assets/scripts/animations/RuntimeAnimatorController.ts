import {
  AnimationClip,
  AnimatorConditionMode,
  AnimatorController,
  AnimatorControllerLayer,
  AnimatorControllerParameter,
  AnimatorControllerParameterType,
  AnimatorState,
  AnimatorStateMachine,
  AnimatorStateTransition,
  BlendTree,
  BlendTreeType,
  TransitionInterruptionSource,
  Vec2
} from "./AnimatorControllerAsset";
import {clamp01, log} from "cc";
import {sampleWeightsCartesian, sampleWeightsDirectional, sampleWeightsPolar} from "./BlendTreeUtils";

export interface IAnimationSource {
  getClipDuration(name: string): number;
}

export type BlendInfo = {
  clip: string;
  weight: number;
  time: number;
  duration: number;
  timeScale: number;
}


export class RuntimeAnimatorController {
  asset: AnimatorController;
  animationSource: IAnimationSource;
  onStateMachineEvent: (evt: string, sm: AnimatorStateMachine) => void;
  onStateEvent: (evt: string, s: RuntimeAnimatorState) => void;
  private _blendInfo: ExList<BlendInfo> = new ExList<BlendInfo>(() => null);
  private blendInfoDirty = true;

  get blendInfo(): ExList<BlendInfo> {
    if (this.blendInfoDirty) {
      this.blendInfoDirty = false;
      let infoList = this._blendInfo;
      infoList.reset();
      this.layers.forEach(layer => {
        let idx = infoList.length;
        infoList.length += layer.curState.blendInfo.length;
        layer.curState.blendInfo.forEach((info, i) => {
          info.weight *= layer.asset.defaultWeight || 0;
          infoList[i + idx] = info;
          return true;
        });
      });
    }
    return this._blendInfo;
  }

  get parameters(): AnimatorControllerParameter[] {
    return this.asset.parameters;
  }

  private parameterValues: { [idx: string]: number | boolean } = {};

  layers: RuntimeAnimatorControllerLayer[];

  constructor(animationSource: IAnimationSource, src: AnimatorController | any) {
    this.animationSource = animationSource;
    this.asset = src;
    this.preprocessAsset(src);

    this.layers = this.asset.layers.map(layer => new RuntimeAnimatorControllerLayer(this, layer));
  }

  private preprocessAsset(src: AnimatorController) {
    if (src.processed) {
      return;
    }
    src.processed = true;
    src.parametersMap = {};
    src.parameters.forEach(p => {
      src.parametersMap[p.name] = p;
      this.parameterValues[p.name] = p.defaultValue;
    });

    src.stateMachinesHashMap = {};
    src.statesHashMap = {};
    src.stateMachinesNameMap = {};
    src.statesNameMap = {};

    src.layers.forEach((layer, i) => {
      layer.idx = i;
      layer.stateMachines.forEach(sm => {
        src.stateMachinesHashMap[sm.id] = sm;
      });
      layer.states.forEach(s => {
        src.statesHashMap[s.id] = s;
      });
      layer.stateMachine = src.stateMachinesHashMap[<any>layer.stateMachine];
    });

    src.layers.forEach((layer, i) => {
      let processTrans = t => {
        t.destinationState = src.statesHashMap[<any>t.destinationState];
        t.destinationStateMachine = src.stateMachinesHashMap[<any>t.destinationStateMachine];
      };
      let addStateMachine;
      addStateMachine = (sm: AnimatorStateMachine, parent: AnimatorStateMachine, fullPath: string) => {
        fullPath = sm.fullPath = (fullPath ? fullPath + "." + sm.name : sm.name);
        src.stateMachinesNameMap[fullPath] = sm;
        sm.layer = layer;
        sm.defaultState = src.statesHashMap[<any>sm.defaultState];
        // if (parent) {
        //   parent.stateMachinesMap[sm.name] = sm;
        // }
        sm.stateMachines.forEach((id, i) => {
          sm.stateMachines[i] = src.stateMachinesHashMap[<any>id];
        });
        sm.parent = parent;
        // sm.statesMap = {};
        sm.states.forEach((id, i) => {
          let state = sm.states[i] = src.statesHashMap[<any>id];
          src.statesNameMap[state.fullPath = (fullPath + "." + state.name)] = state;
          state.stateMachine = sm;
          // sm.statesMap[state.name] = state;
          state.transitions.forEach(t => processTrans(t));
        });
        sm.stateMachines.forEach(sm2 => addStateMachine(sm2, sm, fullPath));
        sm.anyStateTransitions.forEach(t => processTrans(t));
      };
      addStateMachine(layer.stateMachine, null, "");
    });
  }

  getStateByFullPath(name: string): AnimatorState {
    return this.asset.statesNameMap[name];
  }

  getStateMachineByFullPath(name: string): AnimatorStateMachine {
    return this.asset.stateMachinesNameMap[name];
  }

  getNumber(name: string): number {
    return <number>this.parameterValues[name] || 0;
  }

  getBool(name: string): boolean {
    return !!this.parameterValues[name];
  }

  getParameterAsset(name: string): AnimatorControllerParameter {
    return this.asset.parametersMap[name];
  }

  setParameter(name: string, value: number | boolean) {
    this.parameterValues[name] = value;
  }

  setTrigger(name: string) {
    this.parameterValues[name] = true;
  }

  update(dt: number) {
    this.blendInfoDirty = true;
    this.layers.forEach(p => p.update(dt));
  }
}

export class ExList<T> {
  private readonly factory: () => T;
  private _length: number = 0;
  private capacity: number = 0;

  public get length(): number {
    return this._length;
  }

  public set length(len: number) {
    this._length = len;
    while (this.capacity < len) {
      this[this.capacity++] = this.factory();
    }
  }

  reset() {
    this._length = 0;
  }

  constructor(factory: () => T) {
    this.factory = factory;
  }

  forEach(callbackfn: (value: T, index?: number) => boolean, thisArg?: any) {
    for (let i = 0; i < this._length; i++) {
      if (!callbackfn.call(thisArg, this[i], i)) {
        return;
      }
    }
  }
}

class RuntimeAnimatorControllerLayer {
  ctr: RuntimeAnimatorController;
  asset: AnimatorControllerLayer;
  curState: RuntimeAnimatorState; // 当前状态
  midState: RuntimeAnimatorState; // 中间状态
  nextState: RuntimeAnimatorState; // 下一个状态

  private static readonly STEP_INIT = 0;
  private static readonly STEP_RUN = 1;
  private static readonly STEP_TRANS = 2;
  private step: number = 0;
  private nextStep = 0;
  private tick: number;

  constructor(ctr: RuntimeAnimatorController, asset: AnimatorControllerLayer) {
    this.ctr = ctr;
    this.asset = asset;
    this.curState = new RuntimeAnimatorState(this);
    this.curState.initForCurState();
    this.nextState = new RuntimeAnimatorState(this, true);
    this.midState = new RuntimeAnimatorState(this, true);
  }

  getFirstState(sm: AnimatorStateMachine): AnimatorState {
    return sm && sm.defaultState;
  }


  update(dt: number) {
    let loop = 0;
    do {
      if (loop++ > 10) {
        log("may be a dead loop");
        break;
      }
      let useTime = 0;
      this.tick++;
      if (this.nextStep >= 0) {
        this.tick = 0;
        this.step = this.nextStep;
        this.nextStep = -1;
        switch (this.step) {
          case RuntimeAnimatorControllerLayer.STEP_INIT:
            useTime = this.onInit(dt);
            break;
          case RuntimeAnimatorControllerLayer.STEP_RUN:
            useTime = this.onRun(dt);
            break;
        }
      }
      dt -= useTime;
      useTime = 0;

      switch (this.step) {
        case RuntimeAnimatorControllerLayer.STEP_RUN:
          useTime = this.onRunUpdate(dt);
          break;
        case RuntimeAnimatorControllerLayer.STEP_TRANS: {
          useTime = this.onTransUpdate(dt);
          break;
        }
      }

      dt -= useTime;
      useTime = 0;
    } while (this.nextStep >= 0);
  }

  private onInit(dt: number): number {
    this.nextState.reset(this.getFirstState(this.asset.stateMachine));
    if (!this.nextState.isValid) {
      this.step = -1;
      return dt;
    }
    this.nextStep = RuntimeAnimatorControllerLayer.STEP_RUN;
    return dt;
  }

  private onRun(dt: number): number {
    let toSM: AnimatorStateMachine;
    if (this.curState.isValid) {
      this.ctr.onStateEvent && this.ctr.onStateEvent("onStateExit", this.curState);
      if (this.curState.curTrans.asset.isExit) {
        this.ctr.onStateMachineEvent && this.ctr.onStateMachineEvent("onStateMachineExit", this.curState.asset.stateMachine);
      }
      toSM = this.curState.curTrans.asset.destinationStateMachine;
    }
    this.curState.reset(this.nextState.asset);
    this.midState.reset(this.curState.asset);
    this.curState.time = this.midState.time = this.nextState.time;
    this.nextState.clear();
    this.curState.curTrans.clear();

    if (toSM) {
      this.ctr.onStateMachineEvent && this.ctr.onStateMachineEvent("onStateMachineEnter", toSM);
    }
    this.ctr.onStateEvent && this.ctr.onStateEvent("onStateEnter", this.curState);

    log("切换状态", this.curState.asset.stateMachine.name + "." + this.curState.asset.name);
    return 0;
  }

  private onRunUpdate(dt: number): number {
    let useTime = this.curState.updateRun(dt);
    if (this.curState.needTrans) {
      this.nextStep = RuntimeAnimatorControllerLayer.STEP_TRANS;
    }
    this.tick > 0 && this.ctr.onStateEvent && this.ctr.onStateEvent("onStateUpdate", this.curState);
    return useTime;
  }

  private onTransUpdate(dt: number): number {
    let useTime = this.curState.updateTrans(dt);
    if (this.curState.needChange) {
      this.nextStep = RuntimeAnimatorControllerLayer.STEP_RUN;
    } else {
      this.ctr.onStateEvent && this.ctr.onStateEvent("onStateUpdate", this.curState);
    }
    return useTime;
  }
}

class RuntimeAnimatorState {
  layer: RuntimeAnimatorControllerLayer;
  asset: AnimatorState;
  transitions: ExList<RuntimeAnimatorStateTransition>;
  private transitionsDirty: boolean;
  curTrans: RuntimeAnimatorStateTransition;
  time: number = 0;// 动画播放归一化时间
  nextTime: number = 0; // 预计算下一帧动画播放归一化时间
  blendInfo: ExList<BlendInfo>;// = new ExList<BlendInfo>(() => <any>{});
  private readonly weights: ExList<number>;// = new ExList<number>(() => 0);

  get ctr(): RuntimeAnimatorController {
    return this.layer.ctr;
  }

  get isValid(): boolean {
    return !!this.asset;
  }

  get needTrans(): boolean {
    return this.curTrans.isValid && this.nextState.isValid;
  }

  private get midState(): RuntimeAnimatorState {
    return this.layer.midState;
  }

  private get nextState(): RuntimeAnimatorState {
    return this.layer.nextState;
  }

  needChange: boolean = false;
  transTime: number = 0;
  interrupted: boolean = false;
  private transChanged: boolean;

  constructor(layer: RuntimeAnimatorControllerLayer, initWeights: boolean = false) {
    this.layer = layer;
    if (initWeights) {
      this.blendInfo = new ExList<BlendInfo>(() => <any>{});
      this.weights = new ExList<number>(() => 0);
    } else {
      this.blendInfo = new ExList<BlendInfo>(() => null);
    }
  }

  clear() {
    this.asset = null;
  }

  reset(stateAsset: AnimatorState): RuntimeAnimatorState {
    this.asset = stateAsset;
    if (!this.asset) {
      return this;
    }
    this.time = this.nextTime = 0;
    this.transTime = 0;
    this.needChange = false;
    this.interrupted = false;
    this.transitionsDirty = true;
    return this;
  }

  initForCurState() {
    this.curTrans = new RuntimeAnimatorStateTransition();
  }

  get speed(): number {
    let s = this.asset;
    return s.speed || 1;
  }

  get speedByMul(): number {
    return this.speed * this.speedMul;
  }

  get speedMul(): number {
    let s = this.asset;
    return (s.speedParameter ? this.ctr.getNumber(s.speedParameter) : 1);
  }

  get durationBySpeed(): number {
    return this.duration / this.speedByMul;
  }

  _duration: number = 0;
  get duration(): number {
    return this._duration;//this.getMotionDuration(this.asset.motion);
  }

  // private getMotionDuration(m: Motion): number {
  //   if (!m) {
  //     return 1;
  //   }
  //   if (~~m.type === 1) {
  //     this.weights.length = 0;
  //     return this.getBlendTreeDuration(m as BlendTree);
  //   } else {
  //     return this.getAnimationClipDuration(m as AnimationClip);
  //   }
  // }
  //
  // private getAnimationClipDuration(ac: AnimationClip): number {
  //   let d = this.ctr.animationSource.getClipDuration(this.layer.asset.avatarMask, ac.clip);
  //   return d === undefined ? 1 : d;
  // }

  // private getBlendTreeDuration(bt: BlendTree): number {
  //   let wts = this.weights;
  //   let start = wts.length;
  //   // this.calcWeights(bt);
  //   let duration = 0;
  //   for (let i = bt.children.length; --i >= 0;) {
  //     duration += this.getMotionDuration(bt.children[i].motion) * bt.children[i].timeScale * wts[start + i];
  //   }
  //   return duration;
  // }


  private getChildThreshold(bt: BlendTree, idx: number) {
    return bt.children[idx].threshold || 0
  }

  private samplePoint: Vec2 = {x: 0, y: 0};

  private fillSamplePoint(bt: BlendTree) {
    this.samplePoint.x = this.ctr.getNumber(bt.blendParameter);
    this.samplePoint.y = this.ctr.getNumber(bt.blendParameterY);
  }

  private calcWeights() {
    this.weights.reset();
    this.blendInfo.reset();
    if (!this.asset.motion) {
      return;
    }
    if (this.asset.motion.type === 1) {
      this.calcBlendTreeWeights(this.asset.motion as BlendTree, 1);
    } else {
      this.calcAnimationClipWeights(this.asset.motion as AnimationClip, 1, 1);
    }
    this._duration = 0;
    this.blendInfo.forEach((info, i) => {
      let d = this.ctr.animationSource.getClipDuration(info.clip);
      info.duration = d === undefined ? 1 : d;
      this._duration += info.duration * info.timeScale * info.weight;
      return true;
    });
  }

  private calcAnimationClipWeights(ac: AnimationClip, baseWeight: number, timeScale: number) {
    let info = this.blendInfo[this.blendInfo.length++];
    info.weight = baseWeight;
    info.clip = ac.clip;
    info.timeScale = timeScale;
  }

  private calcBlendTreeWeights(bt: BlendTree, baseWeight: number) {
    if (bt.children.length == 0) {
      return;
    }
    let wts = this.weights;
    let offset = wts.length;
    let len = bt.children.length;
    wts.length += len;
    if (len == 1) {
      wts[offset] = 1;
      return;
    }
    for (let i = len; --i >= 0;) {
      wts[offset + i] = 0;
    }

    if (baseWeight > 0) {
      switch (~~bt.blendType) {
        case BlendTreeType.Simple1D: {
          let param = this.ctr.getNumber(bt.blendParameter);
          if (param <= this.getChildThreshold(bt, 0)) {
            wts[offset] = 1;
            break;
          } else if (param >= this.getChildThreshold(bt, bt.children.length - 1)) {
            wts[offset + bt.children.length - 1] = 1;
            break;
          } else {
            let i = 0;
            let t0 = this.getChildThreshold(bt, 0);
            while (++i < bt.children.length) {
              let t = this.getChildThreshold(bt, i);
              if (param < t) {
                wts[offset + i - 1] = (t - param) / (t - t0);
                wts[offset + i] = 1 - wts[offset + i - 1];
                break;
              }
              t0 = t;
            }
          }
          break;
        }
        case BlendTreeType.Direct: {
          let totalWeight = 0;
          for (let i = bt.children.length; --i >= 0;) {
            let w = this.ctr.getNumber(bt.children[i].directBlendParameter);
            wts[offset + i] = w;
            totalWeight += w;
          }
          for (let i = bt.children.length; --i >= 0;) {
            wts[offset + i] /= totalWeight;
          }
          break;
        }
        case BlendTreeType.SimpleDirectional2D: {
          this.fillSamplePoint(bt);
          sampleWeightsDirectional(<any>this.samplePoint, bt, wts, offset);
          break;
        }
        case BlendTreeType.FreeformDirectional2D: {
          this.fillSamplePoint(bt);
          sampleWeightsPolar(<any>this.samplePoint, bt, wts, offset);
          break;
        }
        case BlendTreeType.FreeformCartesian2D: {
          this.fillSamplePoint(bt);
          sampleWeightsCartesian(<any>this.samplePoint, bt, wts, offset);
          break;
        }
      }
    }

    bt.children.forEach((c, i) => {
      if (c.motion.type === 1) {
        this.calcBlendTreeWeights((c.motion as BlendTree), wts[i + offset] * baseWeight);
      } else {
        this.calcAnimationClipWeights((c.motion as AnimationClip), wts[i + offset] * baseWeight, c.timeScale);
      }
    });
  }

  private addTrans(state: RuntimeAnimatorState) {
    if (!state.isValid) {
      return;
    }
    let ts = state.asset.transitions;
    let len = this.transitions.length;
    this.transitions.length += ts.length;
    ts.forEach((t, i) => this.transitions[i + len].reset(state, t));
  }

  private addAnyTrans(state: RuntimeAnimatorState) {
    if (!state.isValid) {
      return;
    }
    let ts = this.layer.asset.stateMachine.anyStateTransitions;
    let len = this.transitions.length;
    this.transitions.length += ts.length;
    ts.forEach((t, i) => this.transitions[i + len].reset(state, t));
  }

  private fillTrans() {
    (this.transitions || (this.transitions = new ExList<RuntimeAnimatorStateTransition>(() => new RuntimeAnimatorStateTransition()))).reset();
    this.addAnyTrans(this.midState);
    if (!this.curTrans.isValid) {
      this.addTrans(this.midState);
      return;
    }
    switch (this.curTrans.asset.interruptionSource) {
      default: {
        return;
      }
      case TransitionInterruptionSource.Source: {
        this.addTrans(this.midState);
        return;
      }
      case TransitionInterruptionSource.Destination: {
        this.addTrans(this.nextState);
        return;
      }
      case TransitionInterruptionSource.SourceThenDestination: {
        this.addTrans(this.midState);
        this.addTrans(this.nextState);
        return;
      }
      case TransitionInterruptionSource.DestinationThenSource: {
        this.addTrans(this.nextState);
        this.addTrans(this.midState);
        return;
      }
    }
  }

  private calcNextTime(dt: number) {
    this.nextTime = this.time + dt * this.speedByMul / this.duration;
  }

  private checkTrans(dt: number): number {
    let midState = this.midState;
    let nextState = this.nextState;
    let useTime = dt;

    midState.calcNextTime(useTime);
    let newTrans: RuntimeAnimatorStateTransition = null;
    if (!this.curTrans.isValid || this.curTrans.interruptionEnabled) { // 当前没有变换或者，可被打断
      if (this.transitionsDirty) {
        this.transitionsDirty = false;
        this.fillTrans();
      }
      for (let i = 0, len = this.transitions.length; i < len; i++) {
        let tr = this.transitions[i];
        if (tr.asset.orderedInterruption && tr == this.curTrans) {
          break;
        }
        let useTime2 = tr.update(useTime);
        if (tr.hit) {
          newTrans = tr;
          tr.resetTrigger();
          useTime = useTime2;
          break;
        }
      }
    }

    if (this.transChanged = newTrans && newTrans != this.curTrans) { // 变换变了
      if (this.curTrans.isValid) {
        midState.interrupted = true;
      }
      this.curTrans.reset(newTrans.state, newTrans.asset);
      midState.reset(this.curTrans.state.asset);
      midState.transTime = 0;
      let t = this.curTrans.asset;
      if (t.isExit) {
        let nextSM = midState.asset.stateMachine.parent ? midState.asset.stateMachine.parent : this.layer.asset.stateMachine;
        nextState.reset(this.layer.getFirstState(nextSM));
      } else if (t.destinationState) {
        nextState.reset(t.destinationState);
      } else if (t.destinationStateMachine) {
        nextState.reset(this.layer.getFirstState(t.destinationStateMachine));
      }
      if (nextState.isValid) {
        nextState.time = this.curTrans.asset.offset || 0;
      }
      log("开始变换", midState.asset.name, nextState.asset.name);
      this.transitionsDirty = this.curTrans.interruptionEnabled;
    }
    return useTime;
  }

  private updateTime(dt: number) {
    let midState = this.midState;
    if (!midState.interrupted) {
      midState.time += dt * midState.speedByMul / midState.duration;
    }
    if (midState.asset == this.asset) {
      this.time = midState.time;
      this._duration = midState.duration;
    }
    this.blendInfo.reset();
    this.blendInfo.length += midState.blendInfo.length;
    midState.blendInfo.forEach((info, i) => {
      info.time = midState.time;
      this.blendInfo[i] = info;
      return true;
    });
  }

  updateRun(dt: number): number {
    let midState = this.midState;
    midState.calcWeights();
    let useTime = this.checkTrans(dt);
    this.updateTime(useTime);
    return useTime;
  }

  updateTrans(dt: number): number {
    let midState = this.midState;
    let nextState = this.nextState;
    midState.calcWeights();
    let useTime = dt;
    let duration = this.curTrans.duration;
    if (midState.transTime + dt >= duration) {
      useTime = midState.transTime + dt - duration;
    }
    if (nextState.isValid) {
      nextState.calcWeights();
      nextState.calcNextTime(useTime);
    }

    useTime = this.checkTrans(useTime);

    this.updateTime(useTime);

    if (!this.transChanged) {
      let duration = this.curTrans.duration;
      midState.transTime += this.curTrans.hasFixedDuration ? useTime : useTime * this.midState.speedByMul / midState.duration;
      if (midState.transTime >= duration) {//切换
        this.needChange = true;
      }
      if (nextState.isValid) {
        nextState.time += useTime * nextState.speedByMul / nextState.duration;
        let p = 1 - clamp01(midState.transTime / duration);
        this.blendInfo.forEach(v => {
          v.weight *= p;
          return true;
        });
        let idx = this.blendInfo.length;
        this.blendInfo.length += nextState.blendInfo.length;
        p = 1 - p;
        nextState.blendInfo.forEach((info, i) => {
          info.time = nextState.time;
          info.weight *= p;
          this.blendInfo[i + idx] = info;
          return true;
        });
      }
    }
    return useTime;
  }

  // update(dt: number): number {
  //   let midState = this.midState;
  //   let nextState = this.nextState;
  //   let useTime = dt;
  //   if (this.curTrans.isValid) {
  //     let duration = this.curTrans.transDuration;
  //     if (midState.transTime + dt >= duration) {
  //       useTime = midState.transTime + dt - duration;
  //     }
  //     if (nextState.isValid) {
  //       nextState.calcNextTime(useTime);
  //     }
  //   }
  //
  //   midState.calcNextTime(useTime);
  //   let newTrans: RuntimeAnimatorStateTransition = null;
  //   if (!this.curTrans.isValid || this.curTrans.interruptionEnabled) { // 当前没有变换或者，可被打断
  //     if (this.transitionsDirty) {
  //       this.transitionsDirty = false;
  //       this.fillTrans();
  //     }
  //     for (let i = 0, len = this.transitions.length; i < len; i++) {
  //       let tr = this.transitions[i];
  //       if (tr.transitionAsset.orderedInterruption && tr == this.curTrans) {
  //         break;
  //       }
  //       let useTime2 = tr.update(useTime);
  //       if (tr.hit) {
  //         newTrans = tr;
  //         tr.resetTrigger();
  //         useTime = useTime2;
  //         break;
  //       }
  //     }
  //   }
  //
  //   let transChanged = newTrans && newTrans != this.curTrans;
  //   if (transChanged) { // 变换变了
  //     if (this.curTrans.isValid) {
  //       midState.interrupted = true;
  //     }
  //     this.curTrans.reset(newTrans.state, newTrans.transitionAsset);
  //     midState.reset(this.curTrans.state.asset);
  //     midState.transTime = 0;
  //     let t = this.curTrans.transitionAsset;
  //     if (t.isExit) {
  //       let nextSM = midState.asset.stateMachine.parent ? midState.asset.stateMachine.parent : this.layer.asset.stateMachine;
  //       nextState.reset(this.layer.getFirstState(nextSM));
  //     } else if (t.destinationState) {
  //       nextState.reset(t.destinationState);
  //     } else if (t.destinationStateMachine) {
  //       nextState.reset(this.layer.getFirstState(t.destinationStateMachine));
  //     }
  //     if (nextState.isValid) {
  //       nextState.time = this.curTrans.transitionAsset.offset || 0;
  //     }
  //     log("开始变换", midState.asset.name, nextState.asset.name);
  //     this.transitionsDirty = this.curTrans.interruptionEnabled;
  //   }
  //
  //   if (!transChanged && this.curTrans.isValid) {
  //     let duration = this.curTrans.transDuration;
  //     midState.transTime += useTime;
  //     if (midState.transTime >= duration) {//切换
  //       this.needChange = true;
  //     }
  //     if (nextState.isValid) {
  //       nextState.time += useTime * nextState.speed / nextState.duration;
  //     }
  //   }
  //
  //   if (!midState.interrupted) {
  //     midState.time += useTime * midState.speed / midState.duration;
  //   }
  //
  //   if (midState.asset == this.asset) {
  //     this.time = midState.time;
  //   }
  //
  //   return useTime;
  // }
}

class RuntimeAnimatorStateTransition {
  state: RuntimeAnimatorState;
  asset: AnimatorStateTransition;
  hit: boolean;

  private get layer() {
    return this.state.layer;
  }

  private get ctr() {
    return this.layer.ctr;
  }

  constructor() {
  }

  get isValid(): boolean {
    return !!this.asset;
  }

  get interruptionEnabled(): boolean {
    return ~~this.asset.interruptionSource != TransitionInterruptionSource.None;
  }

  clear() {
    this.asset = null;
  }

  reset(state: RuntimeAnimatorState, asset: AnimatorStateTransition): RuntimeAnimatorStateTransition {
    this.state = state;
    this.asset = asset;
    this.hit = false;
    return this;
  }

  resetTrigger() {
    this.asset.conditions.forEach(c => {
      if (this.ctr.getParameterAsset(c.parameter).type == AnimatorControllerParameterType.Trigger) {
        this.ctr.setParameter(c.parameter, false);
      }
    });
  }

  checkConditions(): boolean {
    return this.asset.conditions.every(cond => {
      switch (cond.mode) {
        case AnimatorConditionMode.Greater:
          return this.ctr.getNumber(cond.parameter) > (cond.threshold || 0);
        case AnimatorConditionMode.Equals:
          return this.ctr.getNumber(cond.parameter) === (cond.threshold || 0);
        case AnimatorConditionMode.If:
          return !!this.ctr.getBool(cond.parameter);
        case AnimatorConditionMode.IfNot:
          return !this.ctr.getBool(cond.parameter);
        case AnimatorConditionMode.Less:
          return this.ctr.getNumber(cond.parameter) < (cond.threshold || 0);
        case AnimatorConditionMode.NotEqual:
          return this.ctr.getNumber(cond.parameter) !== (cond.threshold || 0);
      }
    });
    return true;
  }

  get duration(): number {
    return this.asset.duration || 0;
    // if (this.asset.hasFixedDuration) {
    //   return this.asset.duration || 0;
    // } else {
    //   return this.state.durationBySpeed * (this.asset.duration || 0);
    // }
  }

  get hasFixedDuration(): boolean {
    return !!this.asset.hasFixedDuration;
  }

  // get fixedDuration(): number {
  //   if (this.asset.hasFixedDuration) {
  //     return this.asset.duration || 0;
  //   } else {
  //     return this.state.durationBySpeed * (this.asset.duration || 0);
  //   }
  // }

  update(dt: number): number {
    this.hit = false;
    let useTime = dt;
    if (!this.asset.hasExitTime && this.asset.conditions.length == 0) {
      return useTime;
    }
    let hit = this.checkConditions();
    if (!hit) {
      return useTime;
    }
    if (!this.asset.hasExitTime) {
      this.hit = true;
      return useTime;
    }

    if (this.asset.hasExitTime) {
      let eTime = this.asset.exitTime || 0;
      if (eTime <= 1) {
        eTime += ~~this.state.time;
      }
      if (this.state.time >= eTime) {
        eTime++;
      }
      if (this.state.time < eTime && this.state.nextTime >= eTime) {
        this.hit = true;
        return useTime;
      }
    }
    return useTime;
  }
}