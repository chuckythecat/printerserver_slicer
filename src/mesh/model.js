/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

"use strict";

(function() {

gapp.register("mesh.model", [
    "add.array",    // dep: add.array
    "add.three",    // dep: add.three
    "moto.license", // dep: moto.license
    "mesh.object",  // dep: mesh.object
    "mesh.group",   // dep: mesh.group
    "mesh.util",    // dep: mesh.util
    "mesh.api",     // dep: mesh.api
]);

let mesh = self.mesh = self.mesh || {};
if (mesh.model) return;

let mapp = mesh;
let space = moto.Space;
let worker = moto.client.fn;
let { MeshPhongMaterial, MeshBasicMaterial } = THREE;
let { BufferGeometry, BufferAttribute, DoubleSide, Mesh } = THREE;

/** default materials **/
let materials = mesh.material = {
    unselected: new MeshPhongMaterial({
        side: DoubleSide,
        transparent: true,
        shininess: 100,
        specular: 0x202020,
        color: 0xffff00,
        opacity: 1
    }),
    selected: new MeshPhongMaterial({
        side: DoubleSide,
        transparent: true,
        shininess: 100,
        specular: 0x202020,
        color: 0x00ee00,
        opacity: 1
    }),
    wireframe: new MeshBasicMaterial({
        side: DoubleSide,
        wireframe: true,
        color: 0x0
    }),
};

/** 3D model rendered on plaform **/
mesh.model = class MeshModel extends mesh.object {
    constructor(data, id) {
        super(id);
        let { file, mesh, vertices, indices, normals } = data;

        if (!mesh) {
            dbug.error(`'${file}' missing mesh data`);
            return;
        }

        // remove file name extensions
        let text = file || '';
        let dot = text.lastIndexOf('.');
        if (dot > 0) file = text.substring(0, dot);

        this.file = file || 'unnamed';
        this.load(mesh || vertices, indices, normals);
        // persist in db so it can be restored on page load
        mapp.db.space.put(this.id, { file, mesh });
    }

    get type() {
        return "model";
    }

    get object() {
        return this.mesh;
    }

    get matrix() {
        return this.mesh.matrixWorld.elements;
    }

    // return new group containing just this model in world coordinates
    duplicate() {
        worker.model_duplicate({
            matrix: this.matrix,
            id: this.id
        }).then(data => {
            mesh.api.group.new([new mesh.model({
                file: `${this.file}-dup`,
                mesh: data
            })]).select();
        });
    }

    load(vertices, indices, normals) {
        let geo = new BufferGeometry();
        geo.setAttribute('position', new BufferAttribute(vertices, 3));
        if (indices) geo.setIndex(new BufferAttribute(indices, 1));
        if (!normals) geo.computeVertexNormals();
        let meh = this.mesh = new Mesh(geo, materials.unselected);
        meh.receiveShadow = true;
        meh.castShadow = true;
        meh.renderOrder = 1;
        // sets fallback opacity for wireframe toggle
        this.opacity(1);
        // this ref allows clicks to be traced to models and groups
        meh.model = this;
        // sync data to worker
        worker.model_load({id: this.id, name: this.file, vertices, indices});
    }

    reload(vertices, indices, normals) {
        let was = this.wireframe(false);
        let geo = this.mesh.geometry;
        geo.setAttribute('position', new BufferAttribute(vertices, 3));
        geo.setAttribute('normal', undefined);
        if (indices) geo.setIndex(new BufferAttribute(indices, 1));
        geo.attributes.position.needsUpdate = true;
        if (!normals) geo.computeVertexNormals();
        // sync data to worker
        worker.model_load({id: this.id, name: this.name, vertices, indices});
        // restore wireframe state
        this.wireframe(was);
    }

    get group() {
        return this._group;
    }

    set group(gv) {
        if (gv && this._group && this._group !== gv) {
            throw "models can only belong to one group";
        }
        this._group = gv;
    }

    get attributes() {
        return this.mesh.geometry.attributes;
    }

    get vertices() {
        return this.attributes.position.count;
    }

    get faces() {
        return this.vertices / 3;
    }

    // todo -- put model into its own group
    ungroup() {
        // get current world coordinates
        let { mid } = meh.getBoundingBox();
        // transform mesh into world coordinates
        // move mesh to origin
        // create and add to group
        // move group center back to original center
        geo.moveMesh(-mid.x, -mid.y, -mid.z);
        geo.computeBoundingBox();
        this.move(mid.x, mid.y, mid.z);
    }

    visible(bool) {
        if (bool === undefined) {
            return this.mesh.visible;
        }
        if (bool.toggle) {
            return this.visible(!this.mesh.visible);
        }
        this.mesh.visible = bool;
    }

    material(mat) {
        let op = this.opacity();
        this.mesh.material = mat = mat.clone();
        mat.opacity = op;
        if (op === 1) this.wireframe(false);
    }

    opacity(ov, opt = {}) {
        let mat = this.mesh.material;
        if (ov === undefined) {
            return mat.opacity;
        }
        if (ov.restore) {
            ov = this._op;
        } else if (ov.temp !== undefined) {
            ov = ov.temp;
        } else {
            this._op = ov;
        }
        if (ov <= 0.0) {
            mat.transparent = false;
            mat.opacity = 1;
            mat.visible = false;
        } else {
            mat.transparent = true;
            mat.opacity = ov;
            mat.visible = true;
        }
        space.update();
    }

    wireframe(bool, opt = {}) {
        if (bool === undefined) {
            return this._wire ? {
                enabled: true,
                opacity: this.opacity(),
                color: this._wire ? this._wire.material.color : undefined,
            } : {
                enabled: false
            };
        }
        if (bool.toggle) {
            return this.wireframe(this._wire ? false : true, opt);
        }
        let was = this._wire ? true : false;
        if (was === bool) {
            return was;
        }
        if (this._wire) {
            this.mesh.remove(this._wire);
            this._wire = undefined;
            this.opacity({restore: true});
        }
        if (bool) {
            this._wire = new Mesh(this.mesh.geometry.shallowClone(), materials.wireframe);
            this.mesh.add(this._wire);
            this.opacity({temp: opt.opacity || 0});
        }
        space.update();
        return was;
    }

    remove() {
        if (arguments.length === 0) {
            // direct call requires pass through group
            this.group.remove(this);
            this.group = undefined;
            this.removed = 'pending';
        } else {
            // manage lifecycle with worker, mesh app caches, etc
            this.destroy();
            // tag removed for debugging
            this.removed = 'complete';
        }
    }

    updateBoundsBox() {
        if (this.group)
        mesh.util.defer(this.group.deferUBB);
    }

    // find adjacent faces to clicked point/line on a face
    select(point, face) {
        let geometry = new THREE.SphereGeometry( 0.5, 16, 16 );
        let material = new MeshPhongMaterial( { color: 0x777777, transparent: true, opacity: 0.25 } );
        let sphere = new Mesh( geometry, material );
        let { x, y, z } = point;
        let { a, b, c } = face;
        sphere.position.set(x,y,z);
        space.scene.add(sphere);
        worker.model_select({
            id: this.id, x, y:-z, z:y, a, b, c, matrix: this.matrix
        }).then(data => {
            console.log('located', data);
        });
    }

};

})();
