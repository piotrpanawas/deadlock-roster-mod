// Adds one script include to a compiled Panorama layout and writes the script
// resource. Everything else in the native layout stays byte-for-byte in its
// decoded form; both outputs are read back and verified before success.
//
// Approach credit: ZachZimm/deadlock-release-order (MIT), UiPatcher.
using System.Security.Cryptography;
using System.Text.Json;
using ValveKeyValue;
using ValveResourceFormat;
using ValveResourceFormat.ResourceTypes;

if (args.Length != 6)
{
    Console.Error.WriteLine("Usage: LayoutPatcher native.vxml_c script.js OUTPUT_DIR LAYOUT_PATH SCRIPT_PATH audit.json");
    return 2;
}
var (nativePath, scriptSource, outputDir, layoutRel, scriptRel, auditPath) = (args[0], args[1], args[2], args[3], args[4], args[5]);

using var layout = new Resource();
layout.Read(nativePath);
var snapshots = layout.Blocks.Select(block => block.ToString()).ToArray();
var root = ((BinaryKV3)layout.GetBlockByType(BlockType.LaCo)!).Data.Root["m_AST"]["m_pRoot"];
var children = root["vecChildren"];
if (children.Any(pair => (string?)pair.Value["eType"] == "SCRIPTS"))
{
    throw new InvalidDataException("The native layout already has scripts; review the integration before building.");
}
if (children.Count(pair => (string?)pair.Value["eType"] == "STYLES") != 1)
{
    throw new InvalidDataException("Expected exactly one STYLES section in the native layout.");
}

var reference = Node("REFERENCE_COMPILED");
reference["name"] = new KVObject(scriptRel);
var include = Node("INCLUDE");
include["child"] = reference;
var scripts = Node("SCRIPTS");
scripts["child"] = include;
var patched = KVObject.Array();
foreach (var (_, node) in children)
{
    patched.Add(node);
    if ((string?)node["eType"] == "STYLES")
    {
        patched.Add(scripts);
    }
}
root["vecChildren"] = patched;

var layoutOut = Path.Combine(outputDir, layoutRel);
Directory.CreateDirectory(Path.GetDirectoryName(layoutOut)!);
using (var stream = File.Create(layoutOut))
{
    layout.Serialize(stream);
}

// Read back: the include must be there, and removing it must restore every block.
using var written = new Resource();
written.Read(layoutOut);
var writtenRoot = ((BinaryKV3)written.GetBlockByType(BlockType.LaCo)!).Data.Root["m_AST"]["m_pRoot"];
var writtenChildren = writtenRoot["vecChildren"];
var found = writtenChildren.Where(pair => (string?)pair.Value["eType"] == "SCRIPTS").Select(pair => pair.Value).ToList();
if (found.Count != 1 || (string?)found[0]["child"]["eType"] != "INCLUDE"
    || (string?)found[0]["child"]["child"]["name"] != scriptRel)
{
    throw new InvalidDataException("Script include did not survive the round trip.");
}
var restored = KVObject.Array();
foreach (var (_, node) in writtenChildren.Where(pair => (string?)pair.Value["eType"] != "SCRIPTS"))
{
    restored.Add(node);
}
writtenRoot["vecChildren"] = restored;
for (var i = 0; i < snapshots.Length; i++)
{
    if (written.Blocks[i].ToString() != snapshots[i])
    {
        throw new InvalidDataException($"Unexpected layout change in block {written.Blocks[i].Type}.");
    }
}

// PanoramaScript v4: one DATA block holding the raw UTF-8 JavaScript.
var payload = File.ReadAllBytes(scriptSource);
var scriptOut = Path.Combine(outputDir, scriptRel);
Directory.CreateDirectory(Path.GetDirectoryName(scriptOut)!);
using (var writer = new BinaryWriter(File.Create(scriptOut)))
{
    writer.Write((uint)(28 + payload.Length)); // file size
    writer.Write((ushort)12);                  // header version
    writer.Write((ushort)4);                   // resource version
    writer.Write((uint)8);                     // offset to block table
    writer.Write((uint)1);                     // block count
    writer.Write("DATA"u8.ToArray());
    writer.Write((uint)8);                     // offset to data, relative to this field
    writer.Write((uint)payload.Length);
    writer.Write(payload);
}
using var script = new Resource();
script.Read(scriptOut);
if (!((Panorama)script.DataBlock!).Data.SequenceEqual(payload))
{
    throw new InvalidDataException("Script resource did not survive the round trip.");
}

static string Sha256(string path) => Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path)));
var audit = new Dictionary<string, object>
{
    ["only_script_include_added"] = true,
    ["native_layout_sha256"] = Sha256(nativePath),
    ["layout_sha256"] = Sha256(layoutOut),
    ["script_sha256"] = Sha256(scriptOut),
    ["files"] = new[] { layoutRel, scriptRel },
};
File.WriteAllText(auditPath, JsonSerializer.Serialize(audit, new JsonSerializerOptions { WriteIndented = true }) + "\n");
Console.WriteLine("Layout patched with one script include; layout and script round trips verified.");
return 0;

static KVObject Node(string type)
{
    var node = KVObject.Collection();
    node["eType"] = new KVObject(type);
    return node;
}
