'use strict';
var Cesium = require('cesium');
var fsExtra = require('fs-extra');
var gltfPipeline = require('gltf-pipeline');
var mime = require('mime');
var path = require('path');
var Promise = require('bluebird');

var Cartesian3 = Cesium.Cartesian3;
var combine = Cesium.combine;
var defaultValue = Cesium.defaultValue;
var defined = Cesium.defined;

var gltfToGlb = gltfPipeline.gltfToGlb;

module.exports = createGltf;

var sizeOfUint8 = 1;
var sizeOfUint16 = 2;
var sizeOfFloat32 = 4;

/**
 * Create a glTF from a Mesh.
 *
 * @param {Object} options An object with the following properties:
 * @param {Mesh} options.mesh The mesh.
 * @param {Boolean} [options.useBatchIds=true] Modify the glTF to include the batchId vertex attribute.
 * @param {Boolean} [options.relativeToCenter=false] Use the Cesium_RTC extension.
 * @param {Boolean} [options.quantization=false] Save glTF with quantized attributes.
 * @param {Boolean} [options.deprecated=false] Save the glTF with the old BATCHID semantic.
 * @param {Object|Object[]} [options.textureCompressionOptions] Options for compressing textures in the glTF.
 * @param {String} [options.upAxis='Y'] Specifies the up-axis for the glTF model.
 *
 * @returns {Promise} A promise that resolves with the binary glTF buffer.
 */
function createGltf(options) {
    var useBatchIds = defaultValue(options.useBatchIds, true);
    var relativeToCenter = defaultValue(options.relativeToCenter, false);
    var quantization = defaultValue(options.quantization, false);
    var deprecated = defaultValue(options.deprecated, false);
    var textureCompressionOptions = options.textureCompressionOptions;
    var upAxis = defaultValue(options.upAxis, 'Y');

    var mesh = options.mesh;
    var positions = mesh.positions;
    var normals = mesh.normals;
    var uvs = mesh.uvs;
    var vertexColors = mesh.vertexColors;
    var batchIds = mesh.batchIds;
    var indices = mesh.indices;
    var views = mesh.views;

    // If all the vertex colors are 0 then the mesh does not have vertex colors
    var hasVertexColors = !vertexColors.every(function(element) {return element === 0;});

    // Get the center position in WGS84 coordinates
    var center;
    if (relativeToCenter) {
        center = mesh.getCenter();
        mesh.setPositionsRelativeToCenter();
    }

    var rootMatrix;
    if (upAxis === 'Y') {
        // Models are z-up, so add a z-up to y-up transform.
        // The glTF spec defines the y-axis as up, so this is the default behavior.
        // In Cesium a y-up to z-up transform is applied later so that the glTF and 3D Tiles coordinate systems are consistent
        rootMatrix = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
    } else if (upAxis === 'Z') {
        // No conversion needed - models are already z-up
        rootMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    }

    var i;
    var positionMinMax = getMinMax(positions, 3);
    var positionLength = positions.length;
    var positionBuffer = Buffer.alloc(positionLength * sizeOfFloat32);
    for (i = 0; i < positionLength; ++i) {
        positionBuffer.writeFloatLE(position[i], i * sizeOfFloat32);
    }

    var normalsMinMax = getMinMax(normals, 3);
    var normalsLength = normals.length;
    var normalBuffer = Buffer.alloc(normalsLength * sizeOfFloat32);
    for (i = 0; i < normalsLength; ++i) {
        normalBuffer.writeFloatLE(normals[i], i * sizeOfFloat32);
    }

    var uvsMinMax = getMinMax(uvs, 2);
    var uvsLength = uvs.length;
    var uvBuffer = Buffer.alloc(uvsLength * sizeOfFloat32);
    for (i = 0; i < uvsLength; ++i) {
        uvBuffer.writeFloatLE(uvs[i], i * sizeOfFloat32);
    }

    var vertexColorsMinMax;
    var vertexColorBuffer = Buffer.alloc(0);
    if (hasVertexColors) {
        vertexColorsMinMax = getMinMax(vertexColors, 4);
        var vertexColorsLength = vertexColors.length;
        vertexColorBuffer = Buffer.alloc(vertexColorsLength, sizeOfUint8);
        for (i = 0; i < vertexColorsLength; ++i) {
            vertexColorBuffer.writeUInt8(vertexColors[i], i);
        }
    }

    var batchIdsMinMax;
    var batchIdBuffer = Buffer.alloc(0);
    var batchIdSemantic = deprecated ? 'BATCHID' : '_BATCHID';
    if (useBatchIds) {
        batchIdsMinMax = getMinMax(batchIds, 1);
        var batchIdsLength = batchIds.length;
        batchIdBuffer = Buffer.alloc(batchIdsLength * sizeOfUint16);
        for (i = 0; i < batchIdsLength; ++i) {
            batchIdBuffer.writeUInt16LE(batchIds[i], i * sizeOfUint16);
        }
    }

    var indicesLength = indices.length;
    var indexBuffer = Buffer.alloc(indicesLength * sizeOfUint16);
    for (i = 0; i < indicesLength; ++i) {
        indexBuffer.writeUInt16LE(indices[i], i * sizeOfUint16);
    }

    var vertexCount = mesh.getVertexCount();

    var buffer = Buffer.concat([positionBuffer, normalBuffer, uvBuffer, vertexColorBuffer, batchIdBuffer, indexBuffer]);
    var bufferUri = 'data:application/octet-stream;base64,' + buffer.toString('base64');
    var byteLength = buffer.byteLength;

    var indexAccessors = {};
    var materials = {};
    var primitives = [];

    var images;
    var samplers;
    var textures;

    var bufferViewIndex = 0;
    var positionBufferViewIndex = bufferViewIndex++;
    var normalBufferViewIndex = bufferViewIndex++;
    var uvBufferViewIndex = bufferViewIndex++;
    var vertexColorBufferViewIndex = hasVertexColors ? bufferViewIndex++ : 0;
    var batchIdBufferViewIndex = useBatchIds ? bufferViewIndex++ : 0;
    var indexBufferViewIndex = bufferViewIndex++;

    var byteOffset = 0;
    var positionBufferByteOffset = byteOffset;
    byteOffset += positionBuffer.length;
    var normalBufferByteOffset = byteOffset;
    byteOffset += normalBuffer.length;
    var uvBufferByteOffset = byteOffset;
    byteOffset += uvBuffer.length;
    var vertexColorBufferByteOffset = byteOffset;
    byteOffset += hasVertexColors ? vertexColorBuffer.length : 0;
    var batchIdBufferByteOffset = byteOffset;
    byteOffset += useBatchIds ? batchIdBuffer.length : 0;
    var indexBufferByteOffset = byteOffset;
    byteOffset += indexBuffer.length;

    var viewsLength = views.length;
    for (i = 0; i < viewsLength; ++i) {
        var view = views[i];
        var material = view.material;
        var indicesMinMax = getMinMax(indices, 1, view.indexOffset, view.indexCount);
        indexAccessors.push({
            bufferView : indexBufferViewIndex,
            byteOffset : sizeOfUint16 * view.indexOffset,
            componentType : 5123, // UNSIGNED_SHORT
            count : view.indexCount,
            type : 'SCALAR',
            min : indicesMinMax.min,
            max : indicesMinMax.max
        });

        var baseColor = material.baseColor;
        var baseColorFactor = baseColor;
        var baseColorTexture;
        var transparent = false;

        if (typeof baseColor === 'string') {
            if (!defined(images)) {
                images = [];
                textures = [];
                samplers = [{
                    magFilter : 9729, // LINEAR
                    minFilter : 9729, // LINEAR
                    wrapS : 10497, // REPEAT
                    wrapT : 10497 // REPEAT
                }];
            }
            baseColorFactor = [1.0, 1.0, 1.0, 1.0];
            baseColorTexture = baseColor;
            images.push({
                uri : baseColor
            });
            textures.push({
                sampler : 0,
                source : images.length - 1
            });
        } else {
            transparent = baseColor[3] < 1.0;
        }

        var doubleSided = transparent;
        var alphaMode = transparent ? 'BLEND' : 'OPAQUE';

        materials.push({
            pbrMetallicRoughness : {
                baseColorFactor : baseColorFactor,
                baseColorTexture : baseColorTexture
            },
            alphaMode : alphaMode,
            doubleSided : doubleSided
        });

        var attributes = {
            POSITION : positionBufferViewIndex,
            NORMAL : normalBufferViewIndex,
            TEXCOORD_0 : uvBufferViewIndex
        };

        if (hasVertexColors) {
            attributes.COLOR_0 = vertexColorBufferViewIndex;
        }

        if (useBatchIds) {
            attributes[batchIdSemantic] = batchIdBufferViewIndex;
        }

        primitives.push({
            attributes : attributes,
            indices : i,
            material : i,
            mode : 4 // TRIANGLES
        });
    }

    var vertexAccessors = [
        {
            bufferView : positionBufferViewIndex,
            byteOffset : 0,
            byteStride : 0,
            componentType : 5126, // FLOAT
            count : vertexCount,
            type : 'VEC3',
            min : positionsMinMax.min,
            max : positionsMinMax.max,
            name : 'positions'
        },
        {
            bufferView : normalBufferViewIndex,
            byteOffset : 0,
            byteStride : 0,
            componentType : 5126, // FLOAT
            count : vertexCount,
            type : 'VEC3',
            min : normalsMinMax.min,
            max : normalsMinMax.max,
            name : 'normals'
        },
        {
            bufferView : uvBufferViewIndex,
            byteOffset : 0,
            byteStride : 0,
            componentType : 5126, // FLOAT
            count : vertexCount,
            type : 'VEC2',
            min : uvsMinMax.min,
            max : uvsMinMax.max,
            name : 'uvs'
        }
    ];

    if (hasVertexColors) {
        vertexAccessors.accessor_vertexColor = {
            bufferView : vertexColorBufferViewIndex,
            byteOffset : 0,
            byteStride : 0,
            componentType : 5121, // UNSIGNED_BYTE
            count : vertexCount,
            type : 'VEC4',
            min : vertexColorsMinMax.min,
            max : vertexColorsMinMax.max,
            normalized : true
        };
    }

    if (useBatchIds) {
        vertexAccessors.push({
            bufferView : batchIdBufferViewIndex,
            byteOffset : 0,
            byteStride : 0,
            componentType : 5123, // UNSIGNED_SHORT
            count : batchIdsLength,
            type : 'SCALAR',
            min : batchIdsMinMax.min,
            max : batchIdsMinMax.max
        });
    }

    var accessors = combine(vertexAccessors, indexAccessors);

    var bufferViews = [
        {
            buffer : 0,
            byteLength : positionBuffer.length,
            byteOffset : positionBufferByteOffset,
            target : 34962 // ARRAY_BUFFER
        },
        {
            buffer : 0,
            byteLength : normalBuffer.length,
            byteOffset : normalBufferByteOffset,
            target : 34962 // ARRAY_BUFFER
        },
        {
            buffer : 0,
            byteLength : uvBuffer.length,
            byteOffset : uvBufferByteOffset,
            target : 34962 // ARRAY_BUFFER
        }
    ];

    if (hasVertexColors) {
        bufferViews.push({
            buffer : 0,
            byteLength : vertexColorBuffer.length,
            byteOffset : vertexColorBufferByteOffset,
            target : 34962 // ARRAY_BUFFER
        });
    }

    if (useBatchIds) {
        bufferViews.push({
            buffer : 0,
            byteLength : batchIdBuffer.length,
            byteOffset : batchIdBufferByteOffset,
            target : 34962 // ARRAY_BUFFER
        });
    }

    bufferViews.push({
        buffer : 0,
        byteLength : indexBuffer.length,
        byteOffset : indexBufferByteOffset,
        target : 34963 // ELEMENT_ARRAY_BUFFER
    });

    var gltf = {
        accessors : accessors,
        asset : {
            generator : '3d-tiles-samples-generator',
            version : '2.0'
        },
        buffers : [{
            byteLength : byteLength,
            uri : bufferUri
        }],
        bufferViews : bufferViews,
        images : images,
        materials : materials,
        meshes : [
            {
                primitives : primitives
            }
        ],
        nodes : [
            {
                matrix : rootMatrix,
                mesh : 0,
                name : 'rootNode'
            }
        ],
        samplers : samplers,
        scene : 0,
        scenes : [{
            nodes : [0]
        }],
        textures : textures
    };

    if (relativeToCenter) {
        gltf.extensionsUsed = ['CESIUM_RTC'];
        gltf.extensions = {
            CESIUM_RTC : {
                center : Cartesian3.pack(center, new Array(3))
            }
        };
    }

    // TODO : add back quantize, compressTextureCoordinates, encodeNormals, and textureCompressionOptions

    return gltfToGlb(gltf)
}

function getMinMax(array, components, start, length) {
    start = defaultValue(start, 0);
    length = defaultValue(length, array.length);
    var min = new Array(components).fill(Number.POSITIVE_INFINITY);
    var max = new Array(components).fill(Number.NEGATIVE_INFINITY);
    var count = length / components;
    for (var i = 0; i < count; ++i) {
        for (var j = 0; j < components; ++j) {
            var index = start + i * components + j;
            var value = array[index];
            min[j] = Math.min(min[j], value);
            max[j] = Math.max(max[j], value);
        }
    }
    return {
        min : min,
        max : max
    };
}
