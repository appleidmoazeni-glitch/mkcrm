<template>
    <!-- begin::navigation -->
	<div class="navigation">
		<div class="navigation-icon-menu">
			<ul>
				<li v-for="menu of user.menu" data-toggle="tooltip" :title="menu.title">
					<a :href="'#'+menu.id"><i :class="'icon '+menu.icon"></i></a>
				</li>
			</ul>
			<ul>
				<li data-toggle="tooltip" title="خروج">
					<i class="icon spinner-border text-white d-none" id="connecting-loader"></i>
					<a href="/admin/logout" @click.prevent="logout" class="go-to-page nav-closable"><i class="icon ti-power-off"></i></a>
				</li>
			</ul>
		</div>
		<div class="navigation-menu-body">
			<ul v-for="menu of user.menu" :id="menu.id">
				<li class="navigation-divider">{{ menu.title }}</li>
				<li v-for="child of menu.children"><router-link :to="child.url">{{ child.title }}</router-link></li>
			</ul>
            <!--<ul id="navigationDashboards" class="navigation-active">
				<li class="navigation-divider">داشبورد</li>
				<li><router-link to="/">وضعیت کلی سیستم</router-link></li>
			</ul>
            <ul id="navigationProducts">
                <li class="navigation-divider">سفارشات</li>
                <li><router-link to="/products">لیست محصولات</router-link></li>
                <li><router-link to="/products/orders">لیست سفارشات</router-link></li>
            </ul>
			<ul id="navigationAds">
				<li class="navigation-divider">تبلیغات</li>
				<li><router-link to="/divar">مدیریت خطوط</router-link></li>
				<li><router-link to="/divar/ads">مدیریت آگهی ها</router-link></li>

				<li class="navigation-divider">خلاصه</li>
				<li>
					<a href="#" class="mb-2">
						<div class="d-flex align-items-center">
							<div>
								<div class="icon-block bg-warning text-white ml-3">
									<i class="ti-bar-chart"></i>
								</div>
							</div>
							<div>
								<h6 class="font-size-13 line-height-22 primary-font m-b-5">کل انتقال‌ها</h6>
								<h4 class="m-b-0 primary-font font-weight-bold line-height-30">15,687</h4>
							</div>
						</div>
					</a>
				</li>
				<li>
					<a href="#" class="mb-2">
						<div class="d-flex align-items-center">
							<div>
								<div class="icon-block bg-success text-white ml-3">
									<i class="ti-bag"></i>
								</div>
							</div>
							<div>
								<h6 class="font-size-13 line-height-22 primary-font m-b-5">پکیج ها</h6>
								<h4 class="m-b-0 primary-font font-weight-bold line-height-30">214</h4>
							</div>
						</div>
					</a>
				</li>
				<li>
					<a href="#">
						<div class="d-flex align-items-center">
							<div>
								<div class="icon-block bg-info text-white ml-3">
									<i class="ti-user"></i>
								</div>
							</div>
							<div>
								<h6 class="font-size-13 line-height-22 primary-font m-b-5">ممبر ذخیره شده</h6>
								<h4 class="m-b-0 primary-font font-weight-bold line-height-30">30,313</h4>
							</div>
						</div>
					</a>
				</li>
			</ul>
			<ul id="navigationSettings">
				<li class="navigation-divider">تنظیمات</li>
                <li><router-link to="/settings/users">مدیریت کاربران</router-link></li>
                <li><router-link to="/settings/groups">مدیریت گروه های کاربری</router-link></li>
                <li><router-link to="/settings/permission">مدیریت سطح دسترسی ها</router-link></li>
                <li><router-link to="/settings/roles">مدیریت نقش ها</router-link></li>
			</ul>-->
		</div>
	</div>
	<!-- end::navigation -->
</template>
<script>
import {mapState} from 'vuex'
import axios from 'axios';
export default {
    computed: mapState(['user']),
	methods: {
		async logout(){
			await axios.post('logout');
			this.$store.state.showPanelFlag = true;
			this.$router.push('/login');
			toastr['info']("با موفقیت خارج شدید ...");
		},
        selectMenu(){
            let ul = $(".router-link-active").parents("ul").eq(0);
            $(".navigation-menu-body ul").removeClass("navigation-active");
            ul.addClass("navigation-active");
            $(".navigation-icon-menu li").removeClass("active");
            $("a[href='#"+ul.attr("id")+"']").parent().addClass("active");
        }
	},
	mounted(){
		socket.on('connect', function(){
			$("#connecting-loader").addClass("d-none");
		});
		socket.on('disconnect', function(){
			$("#connecting-loader").removeClass("d-none");
		});
        this.selectMenu();
	},
	updated() {
        this.selectMenu();
    }
}
</script>
<style>
#connecting-loader{
	position: absolute;
    margin-right: 14px;
    margin-top: 15px;
    font-size: 7px;
}
</style>