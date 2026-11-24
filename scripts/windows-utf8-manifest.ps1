param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference='Stop'
Add-Type -ReferencedAssemblies System.dll,System.Xml.dll -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Xml;
public static class EmcliManifest {
 [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryExW(string file, IntPtr reserved, uint flags);
 [DllImport("kernel32", SetLastError=true)] static extern bool FreeLibrary(IntPtr module);
 [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr FindResourceW(IntPtr module, IntPtr name, IntPtr type);
 [DllImport("kernel32", SetLastError=true)] static extern uint SizeofResource(IntPtr module, IntPtr resource);
 [DllImport("kernel32", SetLastError=true)] static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
 [DllImport("kernel32")] static extern IntPtr LockResource(IntPtr resource);
 delegate bool LanguageCallback(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr param);
 [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EnumResourceLanguagesW(IntPtr module, IntPtr type, IntPtr name, LanguageCallback callback, IntPtr param);
 [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr BeginUpdateResourceW(string file, bool delete);
 [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool UpdateResourceW(IntPtr handle, IntPtr type, IntPtr name, ushort language, byte[] bytes, uint size);
 [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool EndUpdateResourceW(IntPtr handle, bool discard);
 static XmlElement Child(XmlDocument doc, XmlNode parent, string name, string ns) {
  foreach(XmlNode child in parent.ChildNodes) if(child.LocalName==name && child.NamespaceURI==ns) return (XmlElement)child;
  var element=doc.CreateElement(name,ns);parent.AppendChild(element);return element;
 }
 public static void Patch(string file) {
  IntPtr module=LoadLibraryExW(file,IntPtr.Zero,2);
  if(module==IntPtr.Zero) throw new Win32Exception();
  var languages=new List<ushort>();byte[] original;
  try {
   var resource=FindResourceW(module,(IntPtr)1,(IntPtr)24);
   if(resource==IntPtr.Zero) throw new Win32Exception();
   original=new byte[SizeofResource(module,resource)];
   Marshal.Copy(LockResource(LoadResource(module,resource)),original,0,original.Length);
   LanguageCallback callback=(m,t,n,lang,p)=>{languages.Add(lang);return true;};
   if(!EnumResourceLanguagesW(module,(IntPtr)24,(IntPtr)1,callback,IntPtr.Zero)) throw new Win32Exception();
  } finally {FreeLibrary(module);}
  var doc=new XmlDocument();doc.PreserveWhitespace=true;doc.LoadXml(Encoding.UTF8.GetString(original).TrimEnd('\0'));
  const string asm="urn:schemas-microsoft-com:asm.v3";
  var app=Child(doc,doc.DocumentElement,"application",asm);
  var settings=Child(doc,app,"windowsSettings",asm);
  Child(doc,settings,"activeCodePage","http://schemas.microsoft.com/SMI/2019/WindowsSettings").InnerText="UTF-8";
  var bytes=Encoding.UTF8.GetBytes(doc.OuterXml);
  var update=BeginUpdateResourceW(file,false);if(update==IntPtr.Zero)throw new Win32Exception();
  bool success=false;
  try {
   foreach(ushort language in languages)if(!UpdateResourceW(update,(IntPtr)24,(IntPtr)1,language,bytes,(uint)bytes.Length))throw new Win32Exception();
   success=true;
  } finally {if(!EndUpdateResourceW(update,!success))throw new Win32Exception();}
 }
}
'@
[EmcliManifest]::Patch([IO.Path]::GetFullPath($Executable))
