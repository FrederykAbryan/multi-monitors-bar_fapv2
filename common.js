/*
Copyright (C) 2025-2026  Frederyk Abryan Palinoan

This program is free software; you can redistribute it and/or
modify it under the terms of the GNU General Public License
as published by the Free Software Foundation; either version 2
of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program; if not, visit https://www.gnu.org/licenses/.
*/

import * as Utils from './utils.js';

// Shell version for feature detection - centralized here and exported for other modules
export const shellVersion = Utils.SHELL_VERSION;
export const boxLayoutOrientation = Utils.boxLayoutOrientation;

export function patchAddActorMethod(prototype) {
    if (!prototype.add_actor) {
        if (prototype.add_child) {
            prototype.add_actor = function (actor) {
                return this.add_child(actor);
            };
        } else {
            let parent = Object.getPrototypeOf(prototype);
            if (parent && parent.add_child) {
                prototype.add_actor = function (actor) {
                    return this.add_child(actor);
                };
            }
        }
    }
}

export function copyClass(s, d) {
    if (!s) {
        return;
    }
    let propertyNames = Reflect.ownKeys(s.prototype);
    for (let pName of propertyNames.values()) {
        if (typeof pName === "symbol") continue;
        if (Object.prototype.hasOwnProperty.call(d.prototype, pName)) continue;
        if (pName === "prototype") continue;
        if (pName === "constructor") continue;
        let pDesc = Reflect.getOwnPropertyDescriptor(s.prototype, pName);
        if (typeof pDesc !== 'object') continue;
        Reflect.defineProperty(d.prototype, pName, pDesc);
    }

    patchAddActorMethod(d.prototype);
};
