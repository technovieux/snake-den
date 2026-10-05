fn main() {
    println!("cargo:rustc-link-lib=virt");
    tauri_build::build()
}
