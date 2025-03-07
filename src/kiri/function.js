/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

"use strict";

// dep: kiri.api
// dep: kiri.client
// dep: kiri.export
// dep: moto.space
// use: kiri-mode.cam.client
// dep: kiri-mode.fdm.client
// dep: kiri-mode.sla.client
// dep: kiri-mode.laser.driver
gapp.register("kiri.function", [], (root, exports) => {

const { kiri, noop } = root;
const { api, client, consts, utils } = kiri;
const { space } = moto;
const { COLOR, PMODES } = consts;

let complete = {};

function prepareSlices(callback, scale = 1, offset = 0) {
    const { conf, event, feature, hide, mode, view, platform, show } = api;
    const { stacks } = kiri;

    if (view.is_arrange()) {
        let snap = space.screenshot();
        view.snapshot = snap.substring(snap.indexOf(",") + 1);
        client.snap(space.screenshot2({width: 640}));
    }

    if (mode.is_sla() && !callback) {
        callback = preparePreview;
    }

    const widgets = api.widgets.all();
    const settings = conf.get();
    const { device, process, controller } = settings;
    const isBelt = device.bedBelt || false;
    const mark = Date.now();

    // force layout in belt mode when widget exceeds bed length
    if (widgets.length && isBelt) {
        let doLayout = false;
        for (let w of widgets) {
            let bb = w.getBoundingBox();
            let yspan = bb.max.y - bb.min.y;
            if (yspan > device.bedDepth) {
                doLayout = true;
            }
        }
        if (doLayout) {
            platform.layout();
        }
    }

    functions.clear_progress();
    platform.deselect();
    hide.slider();
    view.set_slice();
    conf.save();

    // allow client.js to generate support widgets
    event.emit('slice.begin', settings.mode);

    // refresh widget list because 'slice.begin' may generate support widgets
    const slicing = api.widgets.all()
        .slice()
        .filter(w => !w.track.ignore && !w.meta.disabled);

    if (slicing.length === 0) {
        return api.show.alert('nothing to slice');
    }

    const totalv = slicing.map(w => w.getVertices().count).reduce((a,v) => a + v);
    const defvert = totalv / slicing.length;
    const track = {};

    let totalProgress;

    api.widgets.opacity(COLOR.slicing_opacity);

    let segtimes = {},
        segNumber = 0,
        errored = false,
        startTime = Date.now(),
        toSlice = slicing.slice(),
        camOrLaser = mode.is_cam() || mode.is_laser(),
        extruders = {},
        lastMsg;

    for (let widget of toSlice) {
        widget.belt = null;
        widget.stats.progress = 0;
        widget.setColor(COLOR.slicing);
        let { extruder } = widget.anno;
        if (extruder >= 0) {
            extruders[extruder] = extruder;
        }
    }

    // in multi-material belt mode, the anchor needs to be extended
    // to allow room for the purge tower to be built. calculate here
    extruders = Object.values(extruders);
    if (isBelt && extruders.length > 1 && process.outputPurgeTower) {
        process.beltAnchor = Math.max(
            process.firstLayerBeltLead,
            Math.sqrt(process.outputPurgeTower) * extruders.length * (1/Math.sqrt(2)));
    } else if (isBelt) {
        process.beltAnchor = process.firstLayerBeltLead;
    }

    stacks.clear();
    if (isBelt) {
        // force re-sync in belt mode
        client.clear();
    }
    client.sync(undefined, isBelt);
    client.rotate(settings);

    function sliceNext() {
        if (toSlice.length) {
            // while more widgets to slice
            sliceWidget(toSlice.shift())
        } else {
            // once all slicing done, run sliceAll() once
            client.sliceAll(settings, sliceDone);
        }
    }

    function sliceWidget(widget) {
        widget.stack = stacks.create(widget.id, widget.mesh);
        let factor = (widget.getVertices().count / defvert);

        // compensate for zcut (widget moved through floor)
        widget.stack.obj.view.position.z = widget.track.zcut || 0;

        widget.slice(settings, (sliced, error) => {
            let mark = Date.now();
            // update UI info
            if (sliced) {
                // update segment time
                if (lastMsg) {
                    segtimes[`${widget.id}_${segNumber++}_${lastMsg}`] = mark - startTime;
                }
                event.emit('slice', settings.mode);
            }
            // handle slicing errors
            if (error && !errored) {
                errored = true;
                view.set_arrange();
                show.alert(error, 5);
                show.progress(0);
                client.restart();
                event.emit('slice.error', error);
                setTimeout(view.set_arrange, 1);
            }
            if (errored) {
                // terminate slicing
                sliceDone();
            } else {
                // start next widget slice
                sliceNext();
            }
        }, (update, msg, alert) => {
            if (alert) {
                api.show.alert(alert);
            }
            if (msg && msg !== lastMsg) {
                let mark = Date.now();
                if (lastMsg) {
                    segtimes[`${widget.id}_${segNumber++}_${lastMsg}`] = mark - startTime;
                }
                lastMsg = msg;
                startTime = mark;
            }
            // on update
            if (update >= 0) {
                track[widget.id] = (update || 0) * factor;
                totalProgress = 0;
                for (let w of slicing) {
                    totalProgress += (track[w.id] || 0);
                }
                show.progress(offset + (totalProgress / slicing.length) * scale, msg);
            }
        });
    }

    function sliceDone() {
        let alert = null;
        if (scale === 1 && feature.work_alerts && slicing.length) {
            alert = show.alert("Rendering");
        };
        for (let widget of slicing) {
            // on done
            segtimes[`${widget.id}_${segNumber++}_draw`] = widget.render(widget.stack);
            // rotate stack for belt beds
            if (widget.belt) {
                widget.stack.obj.rotate(widget.belt);
            }
            if (scale === 1) {
                // clear wireframe
                widget.setWireframe(false, COLOR.wireframe, COLOR.wireframe_opacity);
                widget.setOpacity(camOrLaser ? COLOR.cam_sliced_opacity : COLOR.sliced_opacity);
                widget.setColor(COLOR.deselected);
                api.hide.alert(alert);
            }
        }
        view.update_slider_max(true);
        show.layer(-1, 0);
        if (scale === 1) {
            view.update_stack_labels();
        }
        if (!isBelt && controller.lineType === 'line' && !process.xray && !controller.devel) {
            $('render-ghost').onclick();
        }
        if (scale === 1) {
            show.progress(0);
        }
        // cause visuals to update
        space.scene.active();
        // mark slicing complete for prep/preview
        complete.slice = true;
        event.emit('slice.end', settings.mode);
        // print stats
        segtimes.total = Date.now() - mark;
        console.log(segtimes);
        if (callback && typeof callback === 'function') {
            callback();
        }
    }

    // kick of slicing chain
    sliceNext();
}

function preparePreview(callback, scale = 1, offset = 0) {
    const { conf, event, feature, hide, mode, view, platform, show } = api;
    const { stacks } = kiri;

    const widgets = api.widgets.all();
    const settings = conf.get();
    const { device, process, controller } = settings;

    if (complete.preview === feature.pmode) {
        if (device.extruders && device.extruders.length > 1) {
            if (++feature.pmode > 2) {
                feature.pmode = 1;
            }
        } else {
            if (callback) {
                callback();
            }
            return;
        }
    }

    if (!complete.slice) {
        settings.render = false;
        prepareSlices(() => { preparePreview(callback, 0.25, 0.75) }, 0.75);
        return;
    }

    hide.slider(true);

    const isCam = mode.is_cam(), pMode = settings.mode;
    const isDark = api.space.is_dark();
    const isBelt = device.bedBelt || false;

    view.set_preview();
    conf.save();
    event.emit('preview.begin', pMode);

    if (isCam) {
        api.widgets.opacity(isDark ? COLOR.cam_preview_opacity_dark : COLOR.cam_preview_opacity);
        api.widgets.each(widget => {
            widget.setColor(COLOR.cam_preview);
        });
    } else if (offset === 0) {
        api.widgets.opacity(COLOR.preview_opacity);
    }

    let mark = Date.now(),
        segNumber = 0,
        segtimes = {},
        startTime,
        lastMsg,
        output = [];

    // pass preview mode to worker
    settings.pmode = feature.pmode;
    settings.render = true;

    client.prepare(settings, (progress, message, layer) => {
        if (layer) {
            output.push(kiri.codec.decode(layer));
        }
        if (message && message !== lastMsg) {
            const mark = Date.now();
            if (lastMsg) {
                segtimes[`${segNumber++}_${lastMsg}`] = mark - startTime;
            }
            lastMsg = message;
            startTime = mark;
        }
        show.progress(offset + progress * scale, message);
    }, (reply, maxSpeed, minSpeed) => {
        // handle worker errors
        if (reply && reply.error) {
            show.alert(reply.error, 5);
            view.set_arrange();
            show.progress(0);
            space.update();
            event.emit('preview.error', reply.error);
            return;
        }

        if (lastMsg) {
            segtimes[`${segNumber++}_${lastMsg}`] = Date.now() - startTime;
        }

        show.progress(0);
        if (!isCam) {
            api.widgets.opacity(0);
        }

        if (output.length) {
            let alert = feature.work_alerts ? show.alert("Rendering") : null;
            startTime = Date.now();
            stacks.clear();
            const stack = stacks.create('print', space.world)
            output.forEach(layer => {
                stack.add(layer);
            });
            // rotate stack for belt beds
            if (isBelt && widgets[0].belt) {
                let ri = widgets[0].belt;
                ri.dz = 0;
                ri.dy = settings.device.bedDepth / 2;
                stack.obj.rotate(widgets[0].belt);
            }
            api.hide.alert(alert);
            segtimes[`${segNumber}_draw`] = Date.now() - startTime;
        }

        // print stats
        segtimes.total = Date.now() - mark;
        console.log(segtimes);

        event.emit('print', pMode);
        event.emit('preview.end', pMode);

        space.update();
        view.update_slider_max(true);
        show.layer(-1, 0);
        if (feature.pmode === PMODES.SPEED) {
            view.update_speeds(maxSpeed, minSpeed);
        } else {
            view.update_speeds();
        }
        view.update_stack_labels();

        let { controller, process } = settings;
        if (!isBelt && controller.lineType === 'line' && !process.xray && !controller.devel) {
            $('render-ghost').onclick();
        }

        // mark preview complete for export
        complete.preview = feature.pmode;

        if (typeof(callback) === 'function') {
            callback();
        }
    });
}

function prepareAnimation() {
    if (!window.SharedArrayBuffer) {
        api.alerts.show("Невозможно запустить анимацию");
        api.alerts.show("Откройте консоль разработчика чтобы узнать больше.");
        console.log("iframe:")
        if(!isSecureContext) {
            console.log("https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts");
            console.log("TL;DR - use https")
        }
        console.log(`crossOriginIsolated: ${crossOriginIsolated}`);
        if(!crossOriginIsolated) {
            console.log("https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements");
            console.log("TL;DR - following headers on server's response are missing:");
            console.log("Cross-Origin-Opener-Policy: same-origin");
            console.log("Cross-Origin-Embedder-Policy: require-corp");
        }
        return;
    }
    const settings = api.conf.get();
    api.event.emit("function.animate", {mode: settings.mode});
}

function prepareExport() {
    const settings = api.conf.get();
    const argsave = arguments;
    if (!complete.preview) {
        preparePreview(() => { prepareExport(...argsave) });
        return;
    }
    api.event.emit("function.export", {mode: settings.mode});
    complete.export = true;
    kiri.export(...argsave);
}

function cancelWorker() {
    if (client.isBusy()) {
        client.restart();
    }
}

function parseCode(code, type) {
    const { conf, event, show, widgets, view } = api;
    const { stacks } = kiri;
    const settings = conf.get();

    event.emit("code.load", {code, type});
    view.set_preview();
    widgets.opacity(0);

    client.parse({code, type, settings}, progress => {
        show.progress(progress, "parsing");
    }, (layers, maxSpeed, minSpeed) => {
        show.progress(0);
        stacks.clear();
        const stack = stacks.create('parse', space.world);
        layers.forEach(layer => stack.add(layer));
        view.update_slider_max(true);
        view.update_speeds(maxSpeed, minSpeed);
        show.slices();
        view.update_stack_labels();
        space.update();
        event.emit("code.loaded", {code, type});
    });
}

const functions = api.function = {
    slice: prepareSlices,
    print: preparePreview,
    prepare: preparePreview,
    animate: prepareAnimation,
    export: prepareExport,
    cancel: cancelWorker,
    parse: parseCode,
    clear: client.clear,
    clear_progress() { complete = {} }
};

});
